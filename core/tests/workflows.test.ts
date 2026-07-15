import * as z from "zod"
import { expect, test } from "vitest"
import { gate, runOutput, tempLoopy } from "@loopy/test-utils"

const input = z.object({ id: z.string(), value: z.number() })
const output = z.object({ doubled: z.number() })
const options = { input, output, key: (i: z.infer<typeof input>) => `double-${i.id}` }

test("start runs a registered workflow to completion", async () => {
    // given a loopy instance with a registered "double" workflow
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("double", options, async (i) => {
        const doubled = await loopy.step("compute", z.number(), async () => i.value * 2)
        return { doubled }
    })

    // when starting the workflow
    const runId = loopy.start("double", { id: "x", value: 21 })

    // then the run succeeds
    await expect.poll(async () => (await loopy.runs.list())[0]?.status).toBe("succeeded")
    // and the run metadata records the key and workflow name
    const [meta] = await loopy.runs.list()
    expect(runId).toBe(meta.id)
    expect(meta.key).toBe("double-x")
    expect(meta.workflowName).toBe("double")
    // and the run output is the doubled value
    const run = await loopy.runs.get(meta.id)
    expect(run.output).toEqual({ doubled: 42 })
})

test("start validates input against the input schema", async () => {
    // given a loopy instance with a registered "double" workflow
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("double", options, async () => ({ doubled: 0 }))

    // when starting with an input that fails the input schema
    // then it rejects
    expect(() => loopy.start("double", { id: "x", value: "nope" })).toThrow()
    // and no run is recorded
    expect(await loopy.runs.list()).toHaveLength(0)
})

test("start returns before the run finishes", async () => {
    // given a workflow that parks on a gate before completing
    const { loopy } = tempLoopy()
    const parked = gate()
    loopy.registerWorkflow("double", options, async (i) => {
        await parked.released
        return { doubled: i.value * 2 }
    })

    // when starting the workflow
    const runId = loopy.start("double", { id: "x", value: 1 })

    // then the run is still running
    const [meta] = await loopy.runs.list()
    expect(runId).toBe(meta.id)
    expect(meta.status).toBe("running")

    // when the gate is released
    parked.release()

    // then the run succeeds
    await expect.poll(async () => (await loopy.runs.list())[0]?.status).toBe("succeeded")
})

test("start is a no-op while the run is active", async () => {
    // given a workflow that parks on a gate before completing
    const { loopy } = tempLoopy()
    const parked = gate()
    loopy.registerWorkflow("double", options, async (i) => {
        await parked.released
        return { doubled: i.value * 2 }
    })

    // when starting the same workflow key twice while the first run is active
    const firstId = loopy.start("double", { id: "x", value: 1 })
    const secondId = loopy.start("double", { id: "x", value: 1 })

    // then only one run is recorded
    expect(await loopy.runs.list()).toHaveLength(1)
    expect(secondId).toBe(firstId)

    // when the gate is released
    parked.release()

    // then the run succeeds
    await expect.poll(async () => (await loopy.runs.list())[0]?.status).toBe("succeeded")
})

test("workflow output is validated against the output schema", async () => {
    // given a workflow that returns an output violating the output schema
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("double", options, async () => ({ doubled: "nope" }) as any)

    // when starting the workflow
    loopy.start("double", { id: "x", value: 1 })

    // then the run fails
    await expect.poll(async () => (await loopy.runs.list())[0]?.status).toBe("failed")
    // and the run records an error
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    expect(run.error).toBeDefined()
    // and when the failed workflow key is started again
    // then it is rejected and directs the caller to rerun
    expect(() => loopy.start("double", { id: "x", value: 1 })).toThrow(/has failed.*rerun/)
})

test("start of a succeeded workflow returns the existing run ID", async () => {
    // given a registered workflow that has already succeeded
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("double", options, async (value) => ({ doubled: value.value * 2 }))
    const firstId = loopy.start("double", { id: "x", value: 2 })
    expect(await runOutput(loopy, firstId)).toEqual({ doubled: 4 })

    // when the same workflow key is started again
    const secondId = loopy.start("double", { id: "x", value: 99 })

    // then the existing succeeded run ID is returned without re-execution
    expect(secondId).toBe(firstId)
    expect((await loopy.runs.get(secondId)).output).toEqual({ doubled: 4 })
})

test("start resumes an interrupted workflow with its original input", async () => {
    // given a registered workflow interrupted after persisting a step under input value 3
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    loopy.registerWorkflow("double", options, async (value) => {
        await loopy.step("remember", z.number(), async () => value.value)
        reached.release()
        await parked.released
        return { doubled: value.value * 2 }
    })
    const firstId = loopy.start("double", { id: "x", value: 3 })
    await reached.released

    // when a reopened instance starts the same key with a different non-key input
    const second = reopen()
    let resumedInput: number | undefined
    second.registerWorkflow("double", options, async (value) => {
        resumedInput = value.value
        await second.step("remember", z.number(), async () => value.value)
        return { doubled: value.value * 2 }
    })
    const resumedId = second.start("double", { id: "x", value: 100 })

    // then the same attempt resumes and executes with the persisted original input
    expect(resumedId).toBe(firstId)
    expect(await runOutput(second, resumedId)).toEqual({ doubled: 6 })
    expect(resumedInput).toBe(3)
    expect((await second.runs.get(resumedId)).attempt).toBe(1)
})

test("explicit resume continues an interrupted workflow under the same ID", async () => {
    // given an interrupted registered workflow with a succeeded first step
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    let rememberedCalls = 0
    loopy.registerWorkflow("double", options, async (value) => {
        await loopy.step("remember", z.number(), async () => {
            rememberedCalls++
            return value.value
        })
        reached.release()
        await parked.released
        return { doubled: value.value * 2 }
    })
    const firstId = loopy.start("double", { id: "x", value: 4 })
    await reached.released

    // when the run is explicitly resumed on a reopened instance
    const second = reopen()
    second.registerWorkflow("double", options, async (value) => {
        await second.step("remember", z.number(), async () => {
            rememberedCalls++
            return value.value
        })
        return { doubled: value.value * 2 }
    })
    const resumedId = second.resume(firstId)

    // then it returns the same ID, replays the succeeded step, and uses the stored input
    expect(resumedId).toBe(firstId)
    expect(await runOutput(second, resumedId)).toEqual({ doubled: 8 })
    expect(rememberedCalls).toBe(1)
    expect((await second.runs.get(resumedId)).attempt).toBe(1)
})

test("resume validates persisted input before dispatching the workflow", async () => {
    // given an interrupted workflow whose persisted input no longer matches the registered schema
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    loopy.registerWorkflow("double", options, async (value) => {
        reached.release()
        await parked.released
        return { doubled: value.value * 2 }
    })
    const runId = loopy.start("double", { id: "x", value: 4 })
    await reached.released
    const second = reopen()
    let workflowCalls = 0
    second.registerWorkflow(
        "double",
        {
            input: z.object({ id: z.string(), value: z.string() }),
            output,
            key: (value) => `double-${value.id}`
        },
        async () => {
            workflowCalls++
            return { doubled: 0 }
        }
    )

    // when the interrupted run is resumed
    // then persisted input validation rejects before the workflow is dispatched
    expect(() => second.resume(runId)).toThrow()
    expect(workflowCalls).toBe(0)
    // and the original attempt remains interrupted
    expect((await second.runs.get(runId)).status).toBe("interrupted")
})

test("resume of an already running workflow is idempotent", async () => {
    // given a registered workflow that is currently running
    const { loopy } = tempLoopy()
    const parked = gate()
    loopy.registerWorkflow("double", options, async (value) => {
        await parked.released
        return { doubled: value.value * 2 }
    })
    const runId = loopy.start("double", { id: "x", value: 5 })

    // when resume targets the active run
    const resumedId = loopy.resume(runId)

    // then it returns the existing ID without creating another attempt
    expect(resumedId).toBe(runId)
    expect(await loopy.runs.list()).toHaveLength(1)
    parked.release()
    expect(await runOutput(loopy, runId)).toEqual({ doubled: 10 })
})

test("resume rejects missing, terminal, and unregistered runs", async () => {
    // given a registered workflow with one succeeded run and one failed run
    const { loopy, reopen } = tempLoopy()
    let shouldFail = false
    loopy.registerWorkflow("double", options, async (value) => {
        if (shouldFail) throw new Error("boom")
        return { doubled: value.value * 2 }
    })
    const runId = loopy.start("double", { id: "x", value: 6 })
    expect(await runOutput(loopy, runId)).toEqual({ doubled: 12 })
    shouldFail = true
    const failedId = loopy.start("double", { id: "y", value: 6 })
    await expect(runOutput(loopy, failedId)).rejects.toThrow("boom")

    // when resume targets an unknown run
    // then it is rejected as missing
    expect(() => loopy.resume("missing")).toThrow(/not found/)
    // and when resume targets the succeeded run
    // then it is rejected as terminal
    expect(() => loopy.resume(runId)).toThrow(/cannot be resumed/)
    // and when resume targets the failed run
    // then it is also rejected as terminal
    expect(() => loopy.resume(failedId)).toThrow(/cannot be resumed/)
    // and when a reopened instance has not registered the workflow
    const second = reopen()
    // then resume is rejected as unregistered
    expect(() => second.resume(runId)).toThrow(/not registered/)
})

test("resume rejects a non-latest attempt", async () => {
    // given a registered workflow with a failed first attempt and succeeded rerun
    const { loopy } = tempLoopy()
    let shouldFail = true
    loopy.registerWorkflow("double", options, async (value) => {
        const doubled = await loopy.step("compute", z.number(), async () => {
            if (shouldFail) throw new Error("boom")
            return value.value * 2
        })
        return { doubled }
    })
    const firstId = loopy.start("double", { id: "x", value: 7 })
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    shouldFail = false
    const secondId = loopy.rerun(firstId, { from: "compute" })
    expect(await runOutput(loopy, secondId)).toEqual({ doubled: 14 })

    // when resume targets the older attempt
    // then it is rejected because only the latest attempt is eligible
    expect(() => loopy.resume(firstId)).toThrow(/not the latest attempt/)
})

test("start of an unregistered workflow is rejected", async () => {
    // given a loopy instance with no workflows registered
    const { loopy } = tempLoopy()

    // when starting a workflow name that was never registered
    // then it rejects with a "not registered" error
    expect(() => loopy.start("missing", {})).toThrow(/not registered/)
})

test("duplicate workflow registration throws", () => {
    // given a loopy instance with the "double" workflow already registered
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("double", options, async () => ({ doubled: 0 }))

    // when registering a workflow with the same name again
    // then it throws an "already registered" error
    expect(() => loopy.registerWorkflow("double", options, async () => ({ doubled: 0 }))).toThrow(/already registered/)
})

test("a non-idempotent input transform runs once per attempt instead of compounding", async () => {
    // given a workflow whose input schema bumps value by one via a transform
    const { loopy } = tempLoopy()
    let transformCalls = 0
    const seen: number[] = []
    loopy.registerWorkflow(
        "double",
        {
            input: z.object({ id: z.string(), value: z.number() }).transform((i) => {
                transformCalls++
                return { id: i.id, value: i.value + 1 }
            }),
            output,
            key: (i) => `double-${i.id}`
        },
        async (i) => {
            seen.push(i.value)
            const doubled = await loopy.step("compute", z.number(), async () => i.value * 2)
            return { doubled }
        }
    )

    // when starting with value 1 so the transform yields 2
    const runId = loopy.start("double", { id: "x", value: 1 })

    // then the body runs with the once-transformed value, not the doubly-transformed 3
    expect(await runOutput(loopy, runId)).toEqual({ doubled: 4 })
    expect(transformCalls).toBe(1)

    // when the succeeded run is rerun from its first step
    const rerunId = loopy.rerun(runId, { from: "compute" })

    // then the persisted raw input transforms once more, still yielding 4 rather than compounding
    expect(await runOutput(loopy, rerunId)).toEqual({ doubled: 4 })
    // and the transform ran exactly once for each attempt
    expect(transformCalls).toBe(2)
    expect(seen).toEqual([2, 2])
})
