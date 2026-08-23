import * as z from "zod"
import { expect, test } from "vitest"
import { gate, runOutput, tempClankHouse } from "@clankhouse/test-utils"

const input = z.object({ id: z.string(), value: z.number() })
const output = z.object({ doubled: z.number() })
const options = { input, output, key: (i: z.infer<typeof input>) => `double-${i.id}` }

test("start runs a registered workflow to completion", async () => {
    // given a clankhouse instance with a registered "double" workflow
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow("double", options, async (i) => {
        const doubled = await clankhouse.step("compute", z.number(), async () => i.value * 2)
        return { doubled }
    })

    // when starting the workflow
    const runId = clankhouse.start("double", { id: "x", value: 21 })

    // then the run succeeds
    await expect.poll(async () => (await clankhouse.runs.list())[0]?.status).toBe("succeeded")
    // and the run metadata records the key and workflow name
    const [meta] = await clankhouse.runs.list()
    expect(runId).toBe(meta.id)
    expect(meta.key).toBe("double-x")
    expect(meta.workflowName).toBe("double")
    // and the run output is the doubled value
    const run = await clankhouse.runs.get(meta.id)
    expect(run.output).toEqual({ doubled: 42 })
})

test("start validates input against the input schema", async () => {
    // given a clankhouse instance with a registered "double" workflow
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow("double", options, async () => ({ doubled: 0 }))

    // when starting with an input that fails the input schema
    // then it rejects
    expect(() => clankhouse.start("double", { id: "x", value: "nope" })).toThrow()
    // and no run is recorded
    expect(await clankhouse.runs.list()).toHaveLength(0)
})

test("starts and reruns a workflow with omitted void input", async () => {
    // given a workflow with a top-level void input
    const { clankhouse } = tempClankHouse()
    const seen: unknown[] = []
    clankhouse.registerWorkflow(
        "void-input",
        { input: z.void(), output: z.string(), key: () => "void-input" },
        async (input) => {
            seen.push(input)
            return clankhouse.step("record", z.string(), async () => "done")
        }
    )

    // when it is started without input and rerun from its durable step
    const firstRunId = clankhouse.start("void-input")
    await runOutput(clankhouse, firstRunId)
    const secondRunId = clankhouse.rerun(firstRunId, { from: "record" })
    await runOutput(clankhouse, secondRunId)

    // then absence is preserved through registration, persistence, and replay
    expect(seen).toEqual([undefined, undefined])
    expect(clankhouse.workflows.get("void-input")).not.toHaveProperty("inputSchema")
    expect(
        clankhouse.db.prepare("SELECT input FROM runs WHERE workflow_name = ? ORDER BY attempt").all("void-input")
    ).toEqual([{ input: null }, { input: null }])
})

test("start returns before the run finishes", async () => {
    // given a workflow that parks on a gate before completing
    const { clankhouse } = tempClankHouse()
    const parked = gate()
    clankhouse.registerWorkflow("double", options, async (i) => {
        await parked.released
        return { doubled: i.value * 2 }
    })

    // when starting the workflow
    const runId = clankhouse.start("double", { id: "x", value: 1 })

    // then the run is still running
    const [meta] = await clankhouse.runs.list()
    expect(runId).toBe(meta.id)
    expect(meta.status).toBe("running")

    // when the gate is released
    parked.release()

    // then the run succeeds
    await expect.poll(async () => (await clankhouse.runs.list())[0]?.status).toBe("succeeded")
})

test("start is a no-op while the run is active", async () => {
    // given a workflow that parks on a gate before completing
    const { clankhouse } = tempClankHouse()
    const parked = gate()
    clankhouse.registerWorkflow("double", options, async (i) => {
        await parked.released
        return { doubled: i.value * 2 }
    })

    // when starting the same workflow key twice while the first run is active
    const firstId = clankhouse.start("double", { id: "x", value: 1 })
    const secondId = clankhouse.start("double", { id: "x", value: 1 })

    // then only one run is recorded
    expect(await clankhouse.runs.list()).toHaveLength(1)
    expect(secondId).toBe(firstId)

    // when the gate is released
    parked.release()

    // then the run succeeds
    await expect.poll(async () => (await clankhouse.runs.list())[0]?.status).toBe("succeeded")
})

test("workflow output is validated against the output schema", async () => {
    // given a workflow that returns an output violating the output schema
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow("double", options, async () => ({ doubled: "nope" }) as any)

    // when starting the workflow
    clankhouse.start("double", { id: "x", value: 1 })

    // then the run fails
    await expect.poll(async () => (await clankhouse.runs.list())[0]?.status).toBe("failed")
    // and the run records an error
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    expect(run.error).toBeDefined()
    // and when the failed workflow key is started again
    // then it is rejected and directs the caller to rerun
    expect(() => clankhouse.start("double", { id: "x", value: 1 })).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/has failed.*rerun/),
            code: "workflow_run_failed"
        })
    )
})

test("start of a succeeded workflow returns the existing run ID", async () => {
    // given a registered workflow that has already succeeded
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow("double", options, async (value) => ({ doubled: value.value * 2 }))
    const firstId = clankhouse.start("double", { id: "x", value: 2 })
    expect(await runOutput(clankhouse, firstId)).toEqual({ doubled: 4 })

    // when the same workflow key is started again
    const secondId = clankhouse.start("double", { id: "x", value: 99 })

    // then the existing succeeded run ID is returned without re-execution
    expect(secondId).toBe(firstId)
    expect((await clankhouse.runs.get(secondId)).output).toEqual({ doubled: 4 })
})

test("start resumes an interrupted workflow with its original input", async () => {
    // given a registered workflow interrupted after persisting a step under input value 3
    const { clankhouse, reopen } = tempClankHouse()
    const parked = gate()
    const reached = gate()
    clankhouse.registerWorkflow("double", options, async (value) => {
        await clankhouse.step("remember", z.number(), async () => value.value)
        reached.release()
        await parked.released
        return { doubled: value.value * 2 }
    })
    const firstId = clankhouse.start("double", { id: "x", value: 3 })
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
    const { clankhouse, reopen } = tempClankHouse()
    const parked = gate()
    const reached = gate()
    let rememberedCalls = 0
    clankhouse.registerWorkflow("double", options, async (value) => {
        await clankhouse.step("remember", z.number(), async () => {
            rememberedCalls++
            return value.value
        })
        reached.release()
        await parked.released
        return { doubled: value.value * 2 }
    })
    const firstId = clankhouse.start("double", { id: "x", value: 4 })
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
    const { clankhouse, reopen } = tempClankHouse()
    const parked = gate()
    const reached = gate()
    clankhouse.registerWorkflow("double", options, async (value) => {
        reached.release()
        await parked.released
        return { doubled: value.value * 2 }
    })
    const runId = clankhouse.start("double", { id: "x", value: 4 })
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
    expect(() => second.resume(runId)).toThrow(
        expect.objectContaining({
            code: "workflow_input_incompatible",
            message: `Run "${runId}" input no longer matches the input schema of workflow "double": value: Invalid input: expected string, received number`
        })
    )
    expect(workflowCalls).toBe(0)
    // and the original attempt remains interrupted
    expect((await second.runs.get(runId)).status).toBe("interrupted")
})

test("resume of an already running workflow is idempotent", async () => {
    // given a registered workflow that is currently running
    const { clankhouse } = tempClankHouse()
    const parked = gate()
    clankhouse.registerWorkflow("double", options, async (value) => {
        await parked.released
        return { doubled: value.value * 2 }
    })
    const runId = clankhouse.start("double", { id: "x", value: 5 })

    // when resume targets the active run
    const resumedId = clankhouse.resume(runId)

    // then it returns the existing ID without creating another attempt
    expect(resumedId).toBe(runId)
    expect(await clankhouse.runs.list()).toHaveLength(1)
    parked.release()
    expect(await runOutput(clankhouse, runId)).toEqual({ doubled: 10 })
})

test("resume rejects missing, terminal, and unregistered runs", async () => {
    // given a registered workflow with one succeeded run and one failed run
    const { clankhouse, reopen } = tempClankHouse()
    let shouldFail = false
    clankhouse.registerWorkflow("double", options, async (value) => {
        if (shouldFail) throw new Error("boom")
        return { doubled: value.value * 2 }
    })
    const runId = clankhouse.start("double", { id: "x", value: 6 })
    expect(await runOutput(clankhouse, runId)).toEqual({ doubled: 12 })
    shouldFail = true
    const failedId = clankhouse.start("double", { id: "y", value: 6 })
    await expect(runOutput(clankhouse, failedId)).rejects.toThrow("boom")

    // when resume targets an unknown run
    // then it is rejected as missing
    expect(() => clankhouse.resume("missing")).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/not found/),
            code: "workflow_run_not_found"
        })
    )
    // and when resume targets the succeeded run
    // then it is rejected as terminal
    expect(() => clankhouse.resume(runId)).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/cannot be resumed/),
            code: "workflow_run_not_resumable"
        })
    )
    // and when resume targets the failed run
    // then it is also rejected as terminal
    expect(() => clankhouse.resume(failedId)).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/cannot be resumed/),
            code: "workflow_run_not_resumable"
        })
    )
    // and when a reopened instance has not registered the workflow
    const second = reopen()
    // then resume is rejected as unregistered
    expect(() => second.resume(runId)).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/not registered/),
            code: "workflow_not_registered"
        })
    )
})

test("resume rejects a non-latest attempt", async () => {
    // given a registered workflow with a failed first attempt and succeeded rerun
    const { clankhouse } = tempClankHouse()
    let shouldFail = true
    clankhouse.registerWorkflow("double", options, async (value) => {
        const doubled = await clankhouse.step("compute", z.number(), async () => {
            if (shouldFail) throw new Error("boom")
            return value.value * 2
        })
        return { doubled }
    })
    const firstId = clankhouse.start("double", { id: "x", value: 7 })
    await expect(runOutput(clankhouse, firstId)).rejects.toThrow("boom")
    shouldFail = false
    const secondId = clankhouse.rerun(firstId, { from: "compute" })
    expect(await runOutput(clankhouse, secondId)).toEqual({ doubled: 14 })

    // when resume targets the older attempt
    // then it is rejected because only the latest attempt is eligible
    expect(() => clankhouse.resume(firstId)).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/not the latest attempt/),
            code: "workflow_run_not_latest"
        })
    )
})

test("start of an unregistered workflow is rejected", async () => {
    // given a clankhouse instance with no workflows registered
    const { clankhouse } = tempClankHouse()

    // when starting a workflow name that was never registered
    // then it rejects with a "not registered" error
    expect(() => clankhouse.start("missing", {})).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/not registered/),
            code: "workflow_not_registered"
        })
    )
})

test("duplicate workflow registration throws", () => {
    // given a clankhouse instance with the "double" workflow already registered
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow("double", options, async () => ({ doubled: 0 }))

    // when registering a workflow with the same name again
    // then it throws an "already registered" error
    expect(() => clankhouse.registerWorkflow("double", options, async () => ({ doubled: 0 }))).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/already registered/),
            code: "workflow_already_registered"
        })
    )
})

test("workflow registration rejects non-JSON-compatible input and output schemas", () => {
    // given a clankhouse instance and schemas containing JSON-incompatible dates
    const { clankhouse } = tempClankHouse()

    // when registering workflows with an incompatible input or output schema
    // then each registration identifies the incompatible side
    expect(() =>
        clankhouse.registerWorkflow(
            "date-input",
            { input: z.date(), output: z.string(), key: (value) => value.toISOString() },
            async (value) => value.toISOString()
        )
    ).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/Workflow "date-input" input schema.*z\.date/),
            code: "schema_not_json_compatible"
        })
    )
    expect(() =>
        clankhouse.registerWorkflow(
            "date-output",
            { input: z.string(), output: z.date(), key: (value) => value },
            async (value) => new Date(value)
        )
    ).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/Workflow "date-output" output schema.*z\.date/),
            code: "schema_not_json_compatible"
        })
    )
    // and neither failed workflow is registered
    expect(clankhouse.workflows.list()).toEqual([])
})

test("registered workflows can be listed and inspected", () => {
    // given workflows registered out of alphabetical order
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow("zeta", options, async () => ({ doubled: 0 }))
    clankhouse.registerWorkflow("alpha", options, async () => ({ doubled: 0 }))

    // when listing and getting the registered workflows
    const listed = clankhouse.workflows.list()
    const definition = clankhouse.workflows.get("alpha")

    // then names are returned in alphabetical order
    expect(listed).toEqual([{ name: "alpha" }, { name: "zeta" }])
    // and the definition exposes the generated JSON schemas
    expect(definition).toEqual({
        name: "alpha",
        inputSchema: withoutMetaSchema(z.toJSONSchema(options.input, { io: "input" })),
        outputSchema: withoutMetaSchema(z.toJSONSchema(options.output, { io: "output" }))
    })
    // and getting an unknown workflow fails
    expect(() => clankhouse.workflows.get("missing")).toThrow(
        expect.objectContaining({
            message: expect.stringMatching(/not registered/),
            code: "workflow_not_registered"
        })
    )
})

function withoutMetaSchema(schema: z.core.JSONSchema.JSONSchema): z.core.JSONSchema.JSONSchema {
    const without = { ...schema }
    delete without.$schema
    return without
}

test("a non-idempotent input transform runs once per attempt instead of compounding", async () => {
    // given a workflow whose input schema bumps value by one via a transform
    const { clankhouse } = tempClankHouse()
    let transformCalls = 0
    const seen: number[] = []
    clankhouse.registerWorkflow(
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
            const doubled = await clankhouse.step("compute", z.number(), async () => i.value * 2)
            return { doubled }
        }
    )

    // when starting with value 1 so the transform yields 2
    const runId = clankhouse.start("double", { id: "x", value: 1 })

    // then the body runs with the once-transformed value, not the doubly-transformed 3
    expect(await runOutput(clankhouse, runId)).toEqual({ doubled: 4 })
    expect(transformCalls).toBe(1)

    // when the succeeded run is rerun from its first step
    const rerunId = clankhouse.rerun(runId, { from: "compute" })

    // then the persisted raw input transforms once more, still yielding 4 rather than compounding
    expect(await runOutput(clankhouse, rerunId)).toEqual({ doubled: 4 })
    // and the transform ran exactly once for each attempt
    expect(transformCalls).toBe(2)
    expect(seen).toEqual([2, 2])
})
