import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { FakeCodingAgent } from "@clankhouse/core/ai/fake-agent"
import { FakeLLM } from "@clankhouse/core/ai/fake-llm"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import * as sql from "@clankhouse/core/db"
import { GitRepository, type Worktree } from "@clankhouse/core/git"
import { gate, runOutput, tempClankHouse, tempGitRepo, testRun, waitForRun } from "@clankhouse/test-utils"

const DAY_MS = 24 * 60 * 60 * 1000

function onlyRunId(clankhouse: ClankHouse): string {
    return (clankhouse.db.prepare("SELECT id FROM runs").get() as { id: string }).id
}

function waitForAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
}

function insertRun(clankhouse: ClankHouse, id: string, status: sql.PersistedRunStatus, workflowName = "double"): void {
    sql.insertRun(clankhouse.db, {
        id,
        key: `key-${id}`,
        attempt: 1,
        workflow_name: workflowName,
        input: JSON.stringify(1),
        output: null,
        error: null,
        error_code: null,
        status,
        started_at: new Date().toISOString(),
        ended_at: null,
        gc_state: null
    })
}

async function untilStopped(clankhouse: ClankHouse, runId: string): Promise<void> {
    await Array.fromAsync(clankhouse.runs.stream(runId))
}

async function canceledRun(clankhouse: ClankHouse): Promise<{ runId: string; steps: string[] }> {
    const steps: string[] = []
    const started = gate()
    clankhouse.registerWorkflow(
        "cancelable",
        { input: z.number(), output: z.number(), key: (input) => `cancelable-${input}` },
        async (input) => {
            const first = await clankhouse.step("first", z.number(), async () => {
                steps.push("first")
                return input
            })
            await clankhouse.step("park", z.void(), async ({ signal }) => {
                steps.push("park")
                started.release()
                await waitForAbort(signal)
            })
            return first
        }
    )
    const { runId } = clankhouse.start("cancelable", 1)
    await started.released
    clankhouse.cancel(runId)
    await untilStopped(clankhouse, runId)
    return { runId, steps }
}

test("cancel marks an active run canceled immediately and stops it before the next step", async () => {
    // given a run parked in a custom step that waits on its abort signal
    const { clankhouse } = tempClankHouse()
    const parked = gate()
    let laterStarted = false
    const promise = testRun(clankhouse, async () => {
        await clankhouse.step("park", z.void(), async ({ signal }) => {
            parked.release()
            await waitForAbort(signal)
        })
        await clankhouse.step("later", z.void(), async () => {
            laterStarted = true
        })
        return null
    })
    await parked.released
    const runId = onlyRunId(clankhouse)

    // when the run is canceled
    clankhouse.cancel(runId)

    // then the run is canceled right away
    expect((await clankhouse.runs.get(runId)).status).toBe("canceled")
    // and the inline run rejects with the cancel error
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })
    // and the parked step stays interrupted while the later step never starts
    const run = await clankhouse.runs.get(runId)
    expect(run.steps.map((step) => [step.name, step.status])).toEqual([["park", "interrupted"]])
    expect(run.steps[0]).not.toHaveProperty("error")
    expect(laterStarted).toBe(false)
    // and the run keeps its canceled status with an end time and no output
    expect(run).toMatchObject({ status: "canceled", endedAt: expect.any(Date) })
    expect(run).not.toHaveProperty("output")
    expect(run).not.toHaveProperty("error")
})

test("an agent step finishing after cancel stays interrupted with its session released and no snapshot", async () => {
    // given a fake agent that cancels its own run while it is working
    const { clankhouse } = tempClankHouse()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const agent = new FakeCodingAgent(() => {
        clankhouse.cancel(onlyRunId(clankhouse))
        return { changes: [{ file: "done.txt", text: "done\n" }], output: { done: true } }
    })
    let worktree!: Worktree
    let laterStarted = false

    // when the agent step runs and is followed by another step
    const promise = testRun(clankhouse, async () => {
        worktree = await repository.worktree({ base: "main" })
        await agent.run("implement", { prompt: "do it", output: z.object({ done: z.boolean() }), worktree })
        await clankhouse.step("later", z.void(), async () => {
            laterStarted = true
        })
        return null
    })

    // then the run rejects as canceled
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })
    // and the agent finished its work
    expect(fs.readFileSync(path.join(worktree.path, "done.txt"), "utf8")).toBe("done\n")
    // and its step stays interrupted without a snapshot or output
    const run = await clankhouse.runs.get(onlyRunId(clankhouse))
    expect(run.status).toBe("canceled")
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    expect(step).toMatchObject({ status: "interrupted", sessionId: expect.any(String) })
    expect(step).not.toHaveProperty("snapshotRef")
    expect(step.output).toBeUndefined()
    // and its session stays interrupted and is no longer active
    const session = await clankhouse.sessions.get((step as { sessionId: string }).sessionId)
    expect(session.status).toBe("interrupted")
    expect(session.messages.at(-1)).toMatchObject({ type: "message", role: "assistant" })
    // and no later step starts
    expect(laterStarted).toBe(false)
    expect(run.steps.map((candidate) => candidate.name)).toEqual(["worktree", "implement"])
})

test("an LLM step finishing after cancel stays interrupted with its session released", async () => {
    // given a fake LLM that cancels its own run while answering
    const { clankhouse } = tempClankHouse()
    const llm = new FakeLLM(() => {
        clankhouse.cancel(onlyRunId(clankhouse))
        return { summary: "s" }
    })

    // when the LLM step runs
    const promise = testRun(clankhouse, async () =>
        llm.call("summarize", { prompt: "p", output: z.object({ summary: z.string() }) })
    )

    // then the run rejects as canceled
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })
    // and the step and its session stay interrupted
    const run = await clankhouse.runs.get(onlyRunId(clankhouse))
    const step = run.steps[0]!
    expect(step).toMatchObject({ kind: "llm", status: "interrupted" })
    const session = await clankhouse.sessions.get((step as { sessionId: string }).sessionId)
    expect(session.status).toBe("interrupted")
})

test("a custom step that resolves after cancel is discarded", async () => {
    // given a step that cancels its run and then resolves successfully
    const { clankhouse } = tempClankHouse()

    // when the step settles
    const promise = testRun(clankhouse, async () =>
        clankhouse.step("work", z.number(), async () => {
            clankhouse.cancel(onlyRunId(clankhouse))
            return 42
        })
    )

    // then the run rejects as canceled
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })
    // and the step result is not persisted
    const run = await clankhouse.runs.get(onlyRunId(clankhouse))
    expect(run.steps).toMatchObject([{ name: "work", status: "interrupted" }])
    expect(run.steps[0]).not.toHaveProperty("outputJson")
})

test("a workflow that catches the cancel error still ends up canceled without output", async () => {
    // given a workflow that swallows the cancel error and returns a value
    const { clankhouse } = tempClankHouse()
    const parked = gate()
    const promise = testRun(clankhouse, async () => {
        try {
            await clankhouse.step("park", z.void(), async ({ signal }) => {
                parked.release()
                await waitForAbort(signal)
            })
        } catch {
            return "recovered"
        }
        return "finished"
    })
    await parked.released
    const runId = onlyRunId(clankhouse)

    // when the run is canceled
    clankhouse.cancel(runId)

    // then the run still rejects as canceled
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })
    // and the returned value is not persisted
    const run = await clankhouse.runs.get(runId)
    expect(run.status).toBe("canceled")
    expect(run).not.toHaveProperty("output")
})

test("a step called after cancel is not started and rejects with the cancel reason", async () => {
    // given a run that catches the cancel error of its step and attempts another step
    const { clankhouse } = tempClankHouse()
    let starts = 0
    let caught: unknown
    const promise = testRun(clankhouse, async () => {
        await clankhouse
            .step("work", z.void(), async () => {
                clankhouse.cancel(onlyRunId(clankhouse))
            })
            .catch(() => {})
        try {
            await clankhouse.step("after", z.void(), async () => {
                starts++
            })
        } catch (error) {
            caught = error
        }
        return null
    })

    // when the run settles
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })

    // then the later step was rejected with the cancel reason before it started
    expect(caught).toMatchObject({ code: "workflow_run_canceled" })
    expect(starts).toBe(0)
    expect((await clankhouse.runs.get(onlyRunId(clankhouse))).steps.map((step) => step.name)).toEqual(["work"])
})

test("a step called after cancel rejects with the cancel reason before validating its schema", async () => {
    // given a run that catches the cancel error of its step and attempts a step with an unsupported schema
    const { clankhouse } = tempClankHouse()
    let caught: unknown
    const promise = testRun(clankhouse, async () => {
        await clankhouse
            .step("work", z.void(), async () => {
                clankhouse.cancel(onlyRunId(clankhouse))
            })
            .catch(() => {})
        try {
            await clankhouse.step("invalid", z.any(), async () => 1)
        } catch (error) {
            caught = error
        }
        return null
    })

    // when the run settles
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })

    // then the invalid step was rejected with the cancel reason
    expect(caught).toMatchObject({ code: "workflow_run_canceled" })
})

test("a step whose interrupt hook fails still rejects with the cancel reason", async () => {
    // given a step that cancels its run and whose interrupt hook rejects
    const { clankhouse } = tempClankHouse()
    let interrupted = false
    let caught: unknown
    const promise = testRun(clankhouse, async () => {
        try {
            await clankhouse.engine.executeStep({
                kind: "custom",
                name: "work",
                schema: z.void(),
                execute: async () => {
                    clankhouse.cancel(onlyRunId(clankhouse))
                },
                onInterrupt: async () => {
                    interrupted = true
                    throw new Error("cleanup failed")
                }
            })
        } catch (error) {
            caught = error
        }
        return null
    })

    // when the run settles
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })

    // then the hook ran and the step rejected with the cancel reason
    expect(interrupted).toBe(true)
    expect(caught).toMatchObject({ code: "workflow_run_canceled" })
    // and the step stays interrupted
    const run = await clankhouse.runs.get(onlyRunId(clankhouse))
    expect(run.steps).toMatchObject([{ name: "work", status: "interrupted" }])
})

test("canceling an interrupted run that isn't active persists canceled and recover leaves it alone", async () => {
    // given an interrupted run of a registered workflow left behind by an earlier process
    const { clankhouse } = tempClankHouse()
    let executions = 0
    clankhouse.registerWorkflow(
        "double",
        { input: z.number(), output: z.number(), key: (input) => `key-${input}` },
        async (input) => {
            executions++
            return input * 2
        }
    )
    insertRun(clankhouse, "left-behind", "interrupted")

    // when the run is canceled and recovery runs
    clankhouse.cancel("left-behind")
    const result = clankhouse.recover()

    // then the run is canceled with an end time
    expect(await clankhouse.runs.get("left-behind")).toMatchObject({ status: "canceled", endedAt: expect.any(Date) })
    // and recovery doesn't touch it
    expect(result).toEqual({ resumed: [], skipped: [], failed: [] })
    expect(executions).toBe(0)
})

test("cancel is a no-op for canceled runs", async () => {
    // given a canceled run
    const { clankhouse } = tempClankHouse()
    insertRun(clankhouse, "run", "interrupted")
    clankhouse.cancel("run")
    const endedAt = (await clankhouse.runs.get("run")).endedAt

    // when it is canceled again
    clankhouse.cancel("run")

    // then nothing changes
    expect(await clankhouse.runs.get("run")).toMatchObject({ status: "canceled", endedAt })
})

test.each(["succeeded", "failed"] as const)("cancel rejects %s runs", async (status) => {
    // given a finished run
    const { clankhouse } = tempClankHouse()
    insertRun(clankhouse, "run", status)

    // when it is canceled
    const cancel = () => clankhouse.cancel("run")

    // then cancel throws and the status is kept
    expect(cancel).toThrow(expect.objectContaining({ code: "workflow_run_not_cancelable" }))
    expect((await clankhouse.runs.get("run")).status).toBe(status)
})

test("cancel rejects missing and deleted runs", async () => {
    // given a tombstoned run
    const { clankhouse } = tempClankHouse()
    insertRun(clankhouse, "deleted", "succeeded")
    sql.setRunGcState(clankhouse.db, "deleted", "deleted")

    // when missing and deleted runs are canceled
    const missing = () => clankhouse.cancel("missing")
    const deleted = () => clankhouse.cancel("deleted")

    // then the usual lookup errors are thrown
    expect(missing).toThrow(expect.objectContaining({ code: "workflow_run_not_found" }))
    expect(deleted).toThrow(expect.objectContaining({ code: "workflow_run_deleted" }))
})

test("start is a no-op for a canceled run", async () => {
    // given a canceled run
    const { clankhouse } = tempClankHouse()
    const { runId, steps } = await canceledRun(clankhouse)

    // when the same key is started again
    const started = clankhouse.start("cancelable", 1)

    // then the canceled run is returned without executing anything
    expect(started).toEqual({ runId, status: "canceled" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(steps).toEqual(["first", "park"])
})

test("inline run throws for an already canceled run", async () => {
    // given a canceled inline run
    const { clankhouse } = tempClankHouse()
    insertRun(clankhouse, "run", "interrupted", "test-workflow")
    clankhouse.cancel("run")
    let executions = 0

    // when the same run is called inline again
    const promise = testRun(
        clankhouse,
        async () => {
            executions++
            return null
        },
        { key: "key-run" }
    )

    // then it rejects as canceled without executing
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })
    expect(executions).toBe(0)
})

test("inline run rejects a canceled run without waiting for its in-flight step", async () => {
    // given a canceled run whose step ignores the signal and never settles
    const { clankhouse } = tempClankHouse()
    const parked = gate()
    const promise = testRun(clankhouse, async () =>
        clankhouse.step("stubborn", z.void(), async () => {
            parked.release()
            await new Promise<never>(() => {})
        })
    )
    promise.catch(() => {})
    await parked.released
    clankhouse.cancel(onlyRunId(clankhouse))

    // when the same run is called inline again
    const again = testRun(clankhouse, async () => null)

    // then it rejects as canceled right away
    await expect(again).rejects.toMatchObject({ code: "workflow_run_canceled" })
})

test("resume rejects a canceled run", async () => {
    // given a canceled run
    const { clankhouse } = tempClankHouse()
    const { runId } = await canceledRun(clankhouse)

    // when it is resumed
    const resume = () => clankhouse.resume(runId)

    // then it is not resumable
    expect(resume).toThrow(expect.objectContaining({ code: "workflow_run_not_resumable" }))
})

test("rerun accepts a canceled run", async () => {
    // given a canceled run
    const { clankhouse } = tempClankHouse()
    const { runId, steps } = await canceledRun(clankhouse)

    // when it is rerun from the parked step
    const rerunId = clankhouse.rerun(runId, { from: "park" })

    // then a new attempt replays the first step and parks again
    await expect.poll(() => steps).toEqual(["first", "park", "park"])
    expect((await clankhouse.runs.get(rerunId)).attempt).toBe(2)
    clankhouse.cancel(rerunId)
    expect((await waitForRun(clankhouse, rerunId)).status).toBe("canceled")
})

test("rerun rejects a canceled run until its in-flight step settles", async () => {
    // given a canceled run whose first attempt step ignores the signal
    const { clankhouse } = tempClankHouse()
    const parked = gate()
    const finish = gate()
    let attempts = 0
    clankhouse.registerWorkflow(
        "stubborn",
        { input: z.number(), output: z.number(), key: (input) => `stubborn-${input}` },
        async (input) => {
            const first = await clankhouse.step("first", z.number(), async () => input)
            return clankhouse.step("stubborn", z.number(), async () => {
                if (++attempts === 1) {
                    parked.release()
                    await finish.released
                }
                return first + 1
            })
        }
    )
    const { runId } = clankhouse.start("stubborn", 1)
    await parked.released
    clankhouse.cancel(runId)

    // when it is rerun while the step is still in flight
    const rerun = () => clankhouse.rerun(runId, { from: "stubborn" })

    // then the rerun is rejected as in progress
    expect(rerun).toThrow(expect.objectContaining({ code: "workflow_run_in_progress" }))

    // when the canceled attempt's step settles
    finish.release()
    await untilStopped(clankhouse, runId)

    // then the run can be rerun to completion
    const rerunId = clankhouse.rerun(runId, { from: "stubborn" })
    expect(await runOutput(clankhouse, rerunId)).toBe(2)
    // and the canceled attempt keeps its interrupted step
    expect((await clankhouse.runs.get(runId)).status).toBe("canceled")
    expect((await clankhouse.runs.get(runId)).steps.map((step) => step.status)).toEqual(["succeeded", "interrupted"])
})

test("gc collects old canceled runs", async () => {
    // given an old canceled run
    const { clankhouse } = tempClankHouse()
    const { runId } = await canceledRun(clankhouse)
    clankhouse.db
        .prepare("UPDATE runs SET ended_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 15 * DAY_MS).toISOString(), runId)

    // when garbage collection runs
    const result = await clankhouse.gc()

    // then the canceled run is deleted
    expect(result.runs).toEqual({ deleted: 1 })
    await expect(clankhouse.runs.get(runId)).rejects.toMatchObject({ code: "workflow_run_not_found" })
})

test("gc keeps a canceled run that is still finishing a step", async () => {
    // given a canceled run whose step ignores the signal
    const { clankhouse } = tempClankHouse()
    const parked = gate()
    const finish = gate()
    const promise = testRun(clankhouse, async () =>
        clankhouse.step("stubborn", z.void(), async () => {
            parked.release()
            await finish.released
        })
    )
    await parked.released
    const runId = onlyRunId(clankhouse)
    clankhouse.cancel(runId)
    clankhouse.db
        .prepare("UPDATE runs SET ended_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 15 * DAY_MS).toISOString(), runId)

    // when garbage collection runs
    const result = await clankhouse.gc()

    // then the run is kept until it stops
    expect(result.runs).toEqual({ deleted: 0 })
    finish.release()
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })
})

test("an event wait is released on cancel and its key can be waited on again", async () => {
    // given a run waiting on an active source
    const { clankhouse } = tempClankHouse()
    const started = gate()
    let stops = 0
    const source = {
        key: "approval",
        schema: z.number(),
        start() {
            started.release()
            return { stop: () => stops++ }
        }
    }
    const promise = testRun(clankhouse, async () => clankhouse.waitFor(source), { key: "first" })
    await started.released

    // when the run is canceled
    clankhouse.cancel(onlyRunId(clankhouse))

    // then the wait rejects with the cancel error and its source is stopped
    await expect(promise).rejects.toMatchObject({ code: "workflow_run_canceled" })
    expect(stops).toBe(1)
    // and another run can wait on the same key
    const second = testRun(clankhouse, async () => clankhouse.waitFor({ key: "approval", schema: z.number() }), {
        key: "second"
    })
    await expect.poll(async () => (await clankhouse.runs.list({ key: "second" }))[0]?.id).toEqual(expect.any(String))
    const secondId = (await clankhouse.runs.list({ key: "second" }))[0]!.id
    await expect.poll(async () => (await clankhouse.runs.get(secondId)).steps.length).toBe(1)
    await clankhouse.emit("approval", 7)
    expect(await second).toBe(7)
})

test("a custom step function without parameters still works", async () => {
    // given a registered workflow whose step takes no arguments
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow(
        "plain",
        { input: z.number(), output: z.number(), key: (input) => `plain-${input}` },
        async (input) => clankhouse.step("double", z.number(), () => Promise.resolve(input * 2))
    )

    // when it runs
    const { runId } = clankhouse.start("plain", 4)

    // then the step output is returned
    expect(await runOutput(clankhouse, runId)).toBe(8)
})
