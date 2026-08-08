import * as z from "zod"
import { expect, test } from "vitest"
import { Loopy } from "@loopy/core/loopy"
import { LoopyError } from "@loopy/core/errors"
import { gate, tempLoopy, testRun } from "@loopy/test-utils"

test("runs a workflow with durable steps and persists results", async () => {
    // given a fresh loopy instance
    const { loopy } = tempLoopy()

    // when a workflow with two durable steps runs
    const result = await loopy.run("wf", "wf-1", z.number(), async () => {
        const a = await loopy.step("a", z.number(), async () => 1)
        const b = await loopy.step("b", z.number(), async () => a + 1)
        return a + b
    })

    // then it returns the combined step results
    expect(result).toBe(3)
    // and the run is listed as succeeded with the given key and workflow name
    const runs = await loopy.runs.list()
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe("succeeded")
    expect(runs[0].key).toBe("wf-1")
    expect(runs[0].workflowName).toBe("wf")
    // and the persisted run has the output and both step results
    const run = await loopy.runs.get(runs[0].id)
    expect(run.output).toBe(3)
    expect(run.steps.map((s) => [s.key, s.kind, s.status, s.output])).toEqual([
        ["a", "custom", "succeeded", 1],
        ["b", "custom", "succeeded", 2]
    ])
})

test("resume replays succeeded steps without re-executing them", async () => {
    // given a workflow body that can be blocked after step "a" completes
    const { loopy, reopen } = tempLoopy()
    const counts = { a: 0, b: 0 }
    const parked = gate()
    const reached = gate()
    const body = (l: Loopy, block: boolean) => async () => {
        const a = await l.step("a", z.number(), async () => {
            counts.a++
            return 7
        })
        reached.release()
        if (block) await parked.released
        const b = await l.step("b", z.number(), async () => {
            counts.b++
            return a + 1
        })
        return b
    }

    // when the first run executes step "a" and then blocks before step "b"
    testRun(loopy, body(loopy, true)).catch(() => {})
    await reached.released

    // then only step "a" has executed
    expect(counts).toEqual({ a: 1, b: 0 })

    // when the workflow resumes on a reopened loopy instance and runs to completion
    const second = reopen()
    const result = await testRun(second, body(second, false))

    // then it returns the final result using the replayed value of step "a"
    expect(result).toBe(8)
    // and step "a" was not re-executed, only step "b" ran
    expect(counts).toEqual({ a: 1, b: 1 })
    // and the resumed run is recorded as the same attempt, succeeded
    const runs = await second.runs.list()
    expect(runs).toHaveLength(1)
    expect(runs[0].attempt).toBe(1)
    expect(runs[0].status).toBe("succeeded")
})

test("replayed step output is validated against the provided schema", async () => {
    // given a run that completes step "a" with a number output and then blocks
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    testRun(loopy, async () => {
        await loopy.step("a", z.number(), async () => 7)
        reached.release()
        await parked.released
    }).catch(() => {})
    await reached.released
    const second = reopen()

    // when resuming replays step "a" with a mismatched schema
    // then the run rejects because the replayed output fails validation
    await expect(
        testRun(
            second,
            async () => {
                await second.step("a", z.string(), async () => "nope")
            },
            { output: z.void() }
        )
    ).rejects.toThrow()
})

test("a succeeded low-level run is fully validated by the replay schema", async () => {
    // given a succeeded low-level run with a numeric output
    const { loopy } = tempLoopy()
    expect(await loopy.run("wf", "key", z.number(), async () => 7)).toBe(7)
    let calls = 0

    // when the same durable result is requested with an incompatible schema
    const replay = loopy.run("wf", "key", z.string(), async () => {
        calls++
        return "new"
    })

    // then replay validates the parsed stored JSON and does not execute the replacement body
    await expect(replay).rejects.toThrow()
    expect(calls).toBe(0)
})

test("an invalid low-level run schema fails before creating or executing the run", async () => {
    // given a low-level workflow body and a non-JSON output schema
    const { loopy } = tempLoopy()
    let calls = 0

    // when run setup validates the schema
    const promise = loopy.run("wf", "key", z.date(), async () => {
        calls++
        return new Date()
    })

    // then it rejects before the body runs or a run row is inserted
    await expect(promise).rejects.toThrow(/Workflow "wf" output schema.*z\.date/)
    expect(calls).toBe(0)
    expect(loopy.db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 })
})

test("prefix namespaces nested steps", async () => {
    // given a loopy instance
    const { loopy } = tempLoopy()

    // when a workflow nests prefixes and steps at different levels
    await testRun(
        loopy,
        async () => {
            await loopy.prefix("outer", async () => {
                await loopy.prefix("inner", async () => {
                    await loopy.step("a", z.number(), async () => 1)
                })
                await loopy.step("b", z.number(), async () => 2)
            })
            await loopy.step("a", z.number(), async () => 3)
        },
        { output: z.void() }
    )

    // then each step key is namespaced by its enclosing prefixes
    const [meta] = await loopy.runs.list()
    const run = await loopy.runs.get(meta.id)
    expect(run.steps.map((s) => s.key)).toEqual(["outer/inner/a", "outer/b", "a"])
})

test("prefix supports loops and concurrent branches", async () => {
    // given a loopy instance
    const { loopy } = tempLoopy()

    // when a workflow uses prefixes inside a loop and inside concurrent branches
    await testRun(
        loopy,
        async () => {
            for (let i = 0; i < 3; i++) {
                await loopy.prefix(`iter-${i}`, async () => {
                    await loopy.step("work", z.number(), async () => i)
                })
            }
            await Promise.all(
                [1, 2].map((n) =>
                    loopy.prefix(`branch-${n}`, async () => {
                        await loopy.step("work", z.number(), async () => n)
                    })
                )
            )
        },
        { output: z.void() }
    )

    // then every loop iteration and branch produces a distinctly keyed step
    const [meta] = await loopy.runs.list()
    const run = await loopy.runs.get(meta.id)
    expect(run.steps.map((s) => s.key).sort()).toEqual([
        "branch-1/work",
        "branch-2/work",
        "iter-0/work",
        "iter-1/work",
        "iter-2/work"
    ])
})

test("duplicate step key fails the run", async () => {
    // given a loopy instance
    const { loopy } = tempLoopy()

    // when a workflow declares two steps with the same key
    // then the run rejects with a duplicate step error
    await expect(
        testRun(loopy, async () => {
            await loopy.step("a", z.number(), async () => 1)
            await loopy.step("a", z.number(), async () => 2)
        })
    ).rejects.toMatchObject({
        message: expect.stringMatching(/Duplicate step/),
        code: "workflow_step_duplicate"
    })
    // and the run is recorded as failed
    const [meta] = await loopy.runs.list()
    expect(meta.status).toBe("failed")
})

test("step outside a workflow run is rejected", async () => {
    // given a loopy instance with no active run
    const { loopy } = tempLoopy()

    // when a step is invoked outside of a workflow run
    // then it rejects, complaining it must run inside a workflow run
    await expect(loopy.step("a", z.number(), async () => 1)).rejects.toMatchObject({
        message: expect.stringMatching(/inside a workflow run/),
        code: "workflow_context_required"
    })
})

test("persists LoopyError codes on failed runs and steps but leaves ordinary errors uncoded", async () => {
    // given one coded failure and one ordinary failure inside durable steps
    const { loopy } = tempLoopy()
    const coded = testRun(
        loopy,
        async () =>
            loopy.step("coded", z.never(), async () => {
                throw new LoopyError("event_sources_empty", "coded failure")
            }),
        { key: "coded" }
    )
    const ordinary = testRun(
        loopy,
        async () =>
            loopy.step("ordinary", z.never(), async () => {
                throw new Error("ordinary failure")
            }),
        { key: "ordinary" }
    )

    // when both runs fail
    await expect(coded).rejects.toThrow("coded failure")
    await expect(ordinary).rejects.toThrow("ordinary failure")
    const codedId = (await loopy.runs.list({ key: "coded" }))[0]!.id
    const ordinaryId = (await loopy.runs.list({ key: "ordinary" }))[0]!.id
    const codedRun = await loopy.runs.get(codedId)
    const ordinaryRun = await loopy.runs.get(ordinaryId)

    // then only the LoopyError code is exposed and stored at both failure levels
    expect(codedRun).toMatchObject({ error: "coded failure", errorCode: "event_sources_empty" })
    expect(codedRun.steps[0]).toMatchObject({
        error: "coded failure",
        errorCode: "event_sources_empty"
    })
    expect(ordinaryRun).toMatchObject({ error: "ordinary failure" })
    expect(ordinaryRun.errorCode).toBeUndefined()
    expect(ordinaryRun.steps[0]!.errorCode).toBeUndefined()
    expect(loopy.db.prepare("SELECT error_code FROM runs WHERE id = ?").get(codedId)).toEqual({
        error_code: "event_sources_empty"
    })
    expect(loopy.db.prepare("SELECT error_code FROM runs WHERE id = ?").get(ordinaryId)).toEqual({ error_code: null })
})

test("a void step resumes without failing the run", async () => {
    // given a workflow body with a void-typed step, blocked after it completes
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    let cleanups = 0
    const body = (l: Loopy, block: boolean) => async () => {
        await l.step("cleanup", z.void(), async () => {
            cleanups++
        })
        reached.release()
        if (block) await parked.released
        return "done"
    }

    // when the first run executes the void step and then blocks
    testRun(loopy, body(loopy, true)).catch(() => {})
    await reached.released

    // when the workflow resumes on a reopened loopy instance
    // then it completes successfully, replaying the void step
    const second = reopen()
    expect(await testRun(second, body(second, false))).toBe("done")
    // and the void step was not re-executed
    expect(cleanups).toBe(1)
})

test("a run resolving undefined returns undefined on later calls too", async () => {
    // given a workflow body that returns no value
    const { loopy } = tempLoopy()
    const body = async () => {
        await loopy.step("a", z.number(), async () => 1)
    }

    // when the workflow runs for the first time
    // then it resolves undefined
    expect(await testRun(loopy, body, { output: z.void() })).toBeUndefined()
    // and when it runs again with a fresh key it still resolves undefined
    expect(await testRun(loopy, body, { output: z.void() })).toBeUndefined()
})

test("workflows with the same key do not alias each other's runs", async () => {
    // given a loopy instance
    const { loopy } = tempLoopy()

    // when two different workflows run under the same key
    expect(await loopy.run("wfA", "k", z.string(), async () => "A")).toBe("A")
    expect(await loopy.run("wfB", "k", z.string(), async () => "B")).toBe("B")

    // then both runs are listed separately under that key, each its own first attempt
    const runs = await loopy.runs.list({ key: "k" })
    expect(runs.map((r) => [r.workflowName, r.attempt]).sort()).toEqual([
        ["wfA", 1],
        ["wfB", 1]
    ])
})

test("list supports lastN and statuses filters", async () => {
    // given two succeeded runs and one failed run
    const { loopy } = tempLoopy()
    await testRun(loopy, async () => 1, { key: "k1" })
    await testRun(loopy, async () => 2, { key: "k2" })
    await expect(
        testRun(
            loopy,
            async () => {
                throw new Error("boom")
            },
            { key: "k3" }
        )
    ).rejects.toThrow("boom")

    // when listing with lastN
    // then it returns only the most recent N runs
    expect(await loopy.runs.list({ lastN: 2 })).toHaveLength(2)
    // and when filtering by failed status it returns only the failed run's key
    expect((await loopy.runs.list({ statuses: ["failed"] })).map((r) => r.key)).toEqual(["k3"])
    // and combining a succeeded filter with lastN limits the succeeded results
    expect(await loopy.runs.list({ statuses: ["succeeded"], lastN: 1 })).toHaveLength(1)
    // and combining multiple statuses with lastN returns all matching runs
    expect(await loopy.runs.list({ statuses: ["succeeded", "failed"], lastN: 3 })).toHaveLength(3)
})

test("running status is an in-memory overlay on interrupted", async () => {
    // given a workflow whose single step blocks mid-execution
    const { loopy } = tempLoopy()
    const parked = gate()
    const reached = gate()
    const promise = testRun(loopy, async () => {
        await loopy.step("a", z.number(), async () => {
            reached.release()
            await parked.released
            return 1
        })
        return "done"
    })
    await reached.released

    // when the run is still in progress
    // then it is reported as running, both at the list level and the step level
    const [runningMeta] = await loopy.runs.list()
    expect(runningMeta.status).toBe("running")
    const runningRun = await loopy.runs.get(runningMeta.id)
    expect(runningRun.status).toBe("running")
    expect(runningRun.steps[0].status).toBe("running")
    // and the underlying database row still stores the persisted "interrupted" status
    expect(loopy.db.prepare("SELECT status FROM runs").get()).toEqual({ status: "interrupted" })
    // and filtering by status reflects the in-memory "running" overlay, not the db value
    expect(await loopy.runs.list({ statuses: ["running"] })).toHaveLength(1)
    expect(await loopy.runs.list({ statuses: ["succeeded"] })).toHaveLength(0)

    // when the blocked step is released and the run completes
    parked.release()
    await promise

    // then the run and its step are reported as succeeded with the final output
    const [meta] = await loopy.runs.list()
    expect(meta.status).toBe("succeeded")
    const run = await loopy.runs.get(meta.id)
    expect(run.steps[0].status).toBe("succeeded")
    expect(run.output).toBe("done")
})

test("a non-JSON step schema fails before the step executes", async () => {
    // given a workflow whose step schema contains a Date
    const { loopy } = tempLoopy()
    let calls = 0

    // when the workflow reaches the invalid step schema
    const promise = testRun(
        loopy,
        async () => {
            await loopy.step("stamp", z.date(), async () => {
                calls++
                return new Date("2026-07-07T10:00:00.000Z")
            })
        },
        { output: z.void() }
    )

    // then schema setup fails before execution or step persistence
    await expect(promise).rejects.toThrow(/Durable step "stamp" output schema.*z\.date/)
    expect(calls).toBe(0)
    expect(loopy.db.prepare("SELECT COUNT(*) AS n FROM steps").get()).toEqual({ n: 0 })
})
