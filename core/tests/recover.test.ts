import * as z from "zod"
import { expect, test } from "vitest"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import * as sql from "@clankhouse/core/db"
import { gate, runOutput, tempClankHouse } from "@clankhouse/testing"

const input = z.object({ id: z.string(), value: z.number() })
const output = z.object({ doubled: z.number() })
const options = { input, output, key: (i: z.infer<typeof input>) => `double-${i.id}` }

async function interruptRuns(clankhouse: ClankHouse, name: string, ids: string[]): Promise<string[]> {
    const parked = gate()
    const runIds: string[] = []
    clankhouse.registerWorkflow(name, options, async (i) => {
        await clankhouse.step("remember", z.number(), async () => i.value)
        await parked.released
        return { doubled: 0 }
    })
    for (const id of ids) {
        const runId = clankhouse.start(name, { id, value: runIds.length + 1 }).runId
        await expect.poll(async () => (await clankhouse.runs.get(runId)).steps.length).toBe(1)
        runIds.push(runId)
        await new Promise((resolve) => setTimeout(resolve, 2))
    }
    return runIds
}

function insertInterruptedRun(
    clankhouse: ClankHouse,
    run: { id: string; workflowName: string; input: string; startedAt: string }
): void {
    sql.insertRun(clankhouse.db, {
        id: run.id,
        key: `key-${run.id}`,
        attempt: 1,
        workflow_name: run.workflowName,
        input: run.input,
        output: null,
        error: null,
        error_code: null,
        status: "interrupted",
        started_at: run.startedAt,
        ended_at: null,
        gc_state: null
    })
}

function registerDouble(clankhouse: ClankHouse, name: string, recovery?: "resume" | "manual"): string[] {
    const seen: string[] = []
    clankhouse.registerWorkflow(name, { ...options, ...(recovery ? { recovery } : {}) }, async (i) => {
        seen.push(i.id)
        const value = await clankhouse.step("remember", z.number(), async () => -1)
        return { doubled: value * 2 }
    })
    return seen
}

test("recover resumes interrupted runs of workflows with the resume policy", async () => {
    // given three interrupted runs of a workflow
    const { clankhouse, reopen } = tempClankHouse()
    const runIds = await interruptRuns(clankhouse, "double", ["a", "b", "c"])

    // when recover is called on a reopened instance with the resume policy
    const second = reopen()
    const seen = registerDouble(second, "double", "resume")
    const result = second.recover()

    // then all runs are reported as resumed
    expect(result).toEqual({ resumed: runIds, skipped: [], failed: [] })
    // and each run finishes with its stored input and replayed step
    expect(await runOutput(second, runIds[0]!)).toEqual({ doubled: 2 })
    expect(await runOutput(second, runIds[1]!)).toEqual({ doubled: 4 })
    expect(await runOutput(second, runIds[2]!)).toEqual({ doubled: 6 })
    expect(seen).toEqual(["a", "b", "c"])
})

test("recover resumes runs by default when no recovery policy is set", async () => {
    // given an interrupted run
    const { clankhouse, reopen } = tempClankHouse()
    const [runId] = await interruptRuns(clankhouse, "double", ["a"])

    // when recover is called with a workflow registered without a recovery option
    const second = reopen()
    registerDouble(second, "double")
    const result = second.recover()

    // then the run is resumed and succeeds
    expect(result).toEqual({ resumed: [runId], skipped: [], failed: [] })
    expect(await runOutput(second, runId!)).toEqual({ doubled: 2 })
})

test("recover leaves runs of workflows with the manual policy interrupted", async () => {
    // given an interrupted run
    const { clankhouse, reopen } = tempClankHouse()
    const [runId] = await interruptRuns(clankhouse, "double", ["a"])

    // when recover is called with a workflow registered with the manual policy
    const second = reopen()
    const seen = registerDouble(second, "double", "manual")
    const result = second.recover()

    // then the run is skipped as manual
    expect(result).toEqual({ resumed: [], skipped: [{ runId, reason: "manual" }], failed: [] })
    // and it remains interrupted without executing
    expect(seen).toEqual([])
    expect((await second.runs.get(runId!)).status).toBe("interrupted")
    // and it can still be resumed explicitly
    second.resume(runId!)
    expect(await runOutput(second, runId!)).toEqual({ doubled: 2 })
})

test("recover leaves runs of unregistered workflows and inline runs interrupted", async () => {
    // given an interrupted registered workflow run and an interrupted inline run
    const { clankhouse, reopen } = tempClankHouse()
    const [registeredRunId] = await interruptRuns(clankhouse, "double", ["a"])
    const reached = gate()
    void clankhouse.run("inline", "inline-key", z.string(), async () => {
        reached.release()
        return new Promise<string>(() => {})
    })
    await reached.released
    const [inlineRun] = await clankhouse.runs.list({ workflowName: "inline" })

    // when recover is called on a reopened instance without registering any workflow
    const second = reopen()
    const result = second.recover()

    // then both runs are skipped as not registered
    expect(result).toEqual({
        resumed: [],
        skipped: [
            { runId: registeredRunId, reason: "not_registered" },
            { runId: inlineRun!.id, reason: "not_registered" }
        ],
        failed: []
    })
    // and both remain interrupted
    expect((await second.runs.get(registeredRunId!)).status).toBe("interrupted")
    expect((await second.runs.get(inlineRun!.id)).status).toBe("interrupted")
})

test("recover is a no-op for runs already active in this process", async () => {
    // given a run that is currently executing
    const { clankhouse } = tempClankHouse()
    const parked = gate()
    let calls = 0
    clankhouse.registerWorkflow("double", options, async (i) => {
        calls++
        await parked.released
        return { doubled: i.value * 2 }
    })
    const runId = clankhouse.start("double", { id: "a", value: 5 }).runId

    // when recover is called
    const result = clankhouse.recover()

    // then the run is skipped as running
    expect(result).toEqual({ resumed: [], skipped: [{ runId, reason: "running" }], failed: [] })
    // and it finishes from its single execution
    parked.release()
    expect(await runOutput(clankhouse, runId)).toEqual({ doubled: 10 })
    expect(calls).toBe(1)
})

test("recover reports a run with incompatible input and still resumes the others", async () => {
    // given interrupted runs of two workflows
    const { clankhouse, reopen } = tempClankHouse()
    const [incompatibleRunId] = await interruptRuns(clankhouse, "incompatible", ["a"])
    const [okRunId] = await interruptRuns(clankhouse, "double", ["b"])

    // when one workflow is re-registered with an input schema the stored input no longer matches
    const second = reopen()
    let incompatibleCalls = 0
    second.registerWorkflow(
        "incompatible",
        { input: z.object({ id: z.string(), value: z.string() }), output, key: (i) => `double-${i.id}` },
        async () => {
            incompatibleCalls++
            return { doubled: 0 }
        }
    )
    registerDouble(second, "double")
    const result = second.recover()

    // then the incompatible run is reported as failed
    expect(result.failed).toEqual([
        { runId: incompatibleRunId, error: expect.objectContaining({ code: "workflow_input_incompatible" }) }
    ])
    // and the other run is resumed and succeeds
    expect(result.resumed).toEqual([okRunId])
    expect(result.skipped).toEqual([])
    expect(await runOutput(second, okRunId!)).toEqual({ doubled: 2 })
    // and the incompatible run is not executed and stays interrupted
    expect(incompatibleCalls).toBe(0)
    expect((await second.runs.get(incompatibleRunId!)).status).toBe("interrupted")
})

test("recover reports runs whose stored input cannot be parsed and still resumes the others", async () => {
    // given an interrupted run with malformed persisted input
    const { clankhouse } = tempClankHouse()
    insertInterruptedRun(clankhouse, {
        id: "run-malformed",
        workflowName: "double",
        input: "{not json",
        startedAt: "2026-01-01T00:00:00.000Z"
    })
    // and an interrupted run of a workflow whose input refinement throws
    insertInterruptedRun(clankhouse, {
        id: "run-refined",
        workflowName: "refined",
        input: JSON.stringify({ id: "r", value: 1 }),
        startedAt: "2026-01-02T00:00:00.000Z"
    })
    // and an interrupted run with valid input
    insertInterruptedRun(clankhouse, {
        id: "run-ok",
        workflowName: "double",
        input: JSON.stringify({ id: "ok", value: 1 }),
        startedAt: "2026-01-03T00:00:00.000Z"
    })
    const seen = registerDouble(clankhouse, "double")
    let refinedCalls = 0
    clankhouse.registerWorkflow(
        "refined",
        {
            input: input.refine(() => {
                throw new Error("refinement exploded")
            }),
            output,
            key: (i) => i.id
        },
        async () => {
            refinedCalls++
            return { doubled: 0 }
        }
    )

    // when recover is called
    const result = clankhouse.recover()

    // then both unparseable runs are reported as failed with incompatible input
    expect(result.failed).toEqual([
        { runId: "run-malformed", error: expect.objectContaining({ code: "workflow_input_incompatible" }) },
        {
            runId: "run-refined",
            error: expect.objectContaining({
                code: "workflow_input_incompatible",
                message: expect.stringContaining("refinement exploded")
            })
        }
    ])
    // and the valid run is still resumed and succeeds
    expect(result.resumed).toEqual(["run-ok"])
    expect(result.skipped).toEqual([])
    expect(await runOutput(clankhouse, "run-ok")).toEqual({ doubled: -2 })
    // and the unparseable runs are not executed and stay interrupted
    expect(seen).toEqual(["ok"])
    expect(refinedCalls).toBe(0)
    expect((await clankhouse.runs.get("run-malformed")).status).toBe("interrupted")
    expect((await clankhouse.runs.get("run-refined")).status).toBe("interrupted")
})

test("recover does not touch succeeded and failed runs", async () => {
    // given one succeeded and one failed run
    const { clankhouse } = tempClankHouse()
    let calls = 0
    clankhouse.registerWorkflow("double", options, async (i) => {
        calls++
        if (i.value < 0) throw new Error("negative")
        return { doubled: i.value * 2 }
    })
    const succeededId = clankhouse.start("double", { id: "ok", value: 1 }).runId
    const failedId = clankhouse.start("double", { id: "bad", value: -1 }).runId
    await expect.poll(async () => (await clankhouse.runs.get(succeededId)).status).toBe("succeeded")
    await expect.poll(async () => (await clankhouse.runs.get(failedId)).status).toBe("failed")

    // when recover is called
    const result = clankhouse.recover()

    // then nothing is reported or executed again
    expect(result).toEqual({ resumed: [], skipped: [], failed: [] })
    expect(calls).toBe(2)
    expect((await clankhouse.runs.get(succeededId)).status).toBe("succeeded")
    expect((await clankhouse.runs.get(failedId)).status).toBe("failed")
})
