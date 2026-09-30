import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { FakeLLM } from "@clankhouse/core/ai/fake-llm"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { gate, runOutput, tempClankHouse, testRun } from "@clankhouse/test-utils"

const DAY_MS = 24 * 60 * 60 * 1000

function age(clankhouse: ClankHouse, runId: string, days: number): void {
    clankhouse.db
        .prepare("UPDATE runs SET ended_at = ? WHERE id = ?")
        .run(new Date(Date.now() - days * DAY_MS).toISOString(), runId)
}

function gcState(clankhouse: ClankHouse, runId: string): string | null {
    return (clankhouse.db.prepare("SELECT gc_state FROM runs WHERE id = ?").get(runId) as { gc_state: string | null })
        .gc_state
}

function count(clankhouse: ClankHouse, table: string, where: string, ...params: string[]): number {
    return (clankhouse.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number })
        .n
}

async function runIdByKey(clankhouse: ClankHouse, key: string): Promise<string> {
    return (await clankhouse.runs.list({ key }))[0].id
}

async function richRun(clankhouse: ClankHouse, key: string, fail = false): Promise<string> {
    const llm = new FakeLLM(() => ({ summary: "s" }))
    await clankhouse.emit(`event-${key}`, { ok: true })
    await testRun(
        clankhouse,
        async () => {
            await clankhouse.artifacts.writeText("report", "hello")
            await llm.call("summarize", { prompt: "p", output: z.object({ summary: z.string() }) })
            await clankhouse.waitFor({ key: `event-${key}`, schema: z.object({ ok: z.boolean() }) })
            if (fail) throw new Error("boom")
            return null
        },
        { key }
    ).catch(() => {})
    return runIdByKey(clankhouse, key)
}

function expectRunDataGone(clankhouse: ClankHouse, dir: string, runId: string): void {
    expect(gcState(clankhouse, runId)).toBe("deleted")
    expect(count(clankhouse, "steps", "run_id = ?", runId)).toBe(0)
    expect(count(clankhouse, "sessions", "run_id = ?", runId)).toBe(0)
    expect(count(clankhouse, "artifacts", "run_id = ?", runId)).toBe(0)
    expect(fs.existsSync(path.join(dir, "artifacts", runId))).toBe(false)
}

test("gc deletes old succeeded and failed runs with their steps, sessions, artifacts and consumed events", async () => {
    // given an old succeeded run and an old failed run, each with an artifact, an llm session and a consumed event
    const { clankhouse, dir } = tempClankHouse()
    const succeeded = await richRun(clankhouse, "succeeded")
    const failed = await richRun(clankhouse, "failed", true)
    age(clankhouse, succeeded, 15)
    age(clankhouse, failed, 15)

    // when garbage collection runs
    const result = await clankhouse.gc()

    // then both runs are tombstoned without any remaining data
    expect(result.runs).toEqual({ deleted: 2 })
    expectRunDataGone(clankhouse, dir, succeeded)
    expectRunDataGone(clankhouse, dir, failed)
    expect(count(clankhouse, "session_messages", "1 = 1")).toBe(0)
    expect(count(clankhouse, "events", "1 = 1")).toBe(0)
    // and tombstones are hidden from listings and lookups
    expect(await clankhouse.runs.list()).toEqual([])
    await expect(clankhouse.runs.get(succeeded)).rejects.toMatchObject({ code: "workflow_run_not_found" })
})

test("gc keeps recent and interrupted runs", async () => {
    // given a recent succeeded run and an old interrupted run
    const { clankhouse, dir } = tempClankHouse()
    const recent = await richRun(clankhouse, "recent")
    const interrupted = gate()
    void testRun(clankhouse, () => interrupted.released.then(() => null), { key: "interrupted" })
    const interruptedId = await runIdByKey(clankhouse, "interrupted")
    age(clankhouse, interruptedId, 30)

    // when garbage collection runs
    const result = await clankhouse.gc()

    // then nothing is deleted
    expect(result.runs).toEqual({ deleted: 0 })
    expect(gcState(clankhouse, recent)).toBeNull()
    expect(gcState(clankhouse, interruptedId)).toBeNull()
    expect(count(clankhouse, "steps", "run_id = ?", recent)).toBe(3)
    expect(fs.existsSync(path.join(dir, "artifacts", recent))).toBe(true)
    interrupted.release()
})

test("gc keeps a failed run whose parallel step is still executing", async () => {
    // given an old failed run with a parallel branch still inside a step
    const { clankhouse } = tempClankHouse()
    const entered = gate()
    const parked = gate()
    const running = testRun(clankhouse, async () => {
        await Promise.all([
            clankhouse.step("parked", z.null(), async () => {
                entered.release()
                await parked.released
                return null
            }),
            entered.released.then(() => {
                throw new Error("boom")
            })
        ])
        return null
    })
    await expect(running).rejects.toThrow("boom")
    const runId = await runIdByKey(clankhouse, "test-key")
    age(clankhouse, runId, 30)

    // when garbage collection runs
    const result = await clankhouse.gc()

    // then the run is untouched
    expect(result.runs).toEqual({ deleted: 0 })
    expect(gcState(clankhouse, runId)).toBeNull()
    parked.release()
})

test("gc completes runs left deleting by an earlier sweep", async () => {
    // given a recent run that an earlier sweep marked as deleting before failing
    const { clankhouse, dir } = tempClankHouse()
    const runId = await richRun(clankhouse, "leftover")
    clankhouse.db.prepare("UPDATE runs SET gc_state = 'deleting' WHERE id = ?").run(runId)

    // when garbage collection runs again
    const result = await clankhouse.gc()

    // then the leftover run is fully deleted
    expect(result.runs).toEqual({ deleted: 1 })
    expectRunDataGone(clankhouse, dir, runId)
})

test("gc honours minAgeDays and deleteRuns", async () => {
    // given a run that ended three days ago
    const { clankhouse } = tempClankHouse()
    const runId = await richRun(clankhouse, "three-days")
    age(clankhouse, runId, 3)

    // when gc runs with the default threshold or with run deletion disabled
    // then the run is kept
    expect((await clankhouse.gc()).runs).toEqual({ deleted: 0 })
    expect((await clankhouse.gc({ minAgeDays: 2, deleteRuns: false })).runs).toEqual({ deleted: 0 })
    expect(gcState(clankhouse, runId)).toBeNull()
    // and when gc runs with a two-day threshold
    // then the run is deleted
    expect((await clankhouse.gc({ minAgeDays: 2 })).runs).toEqual({ deleted: 1 })
    expect(gcState(clankhouse, runId)).toBe("deleted")
    // and invalid thresholds are rejected
    await expect(clankhouse.gc({ minAgeDays: 0 })).rejects.toThrow(RangeError)
    await expect(clankhouse.gc({ minAgeDays: 1.5 })).rejects.toThrow(RangeError)
})

test("a tombstoned succeeded key stays a no-op for start and makes run throw", async () => {
    // given a registered workflow whose old succeeded run has been deleted
    const { clankhouse } = tempClankHouse()
    let calls = 0
    clankhouse.registerWorkflow(
        "test-workflow",
        { input: z.null(), output: z.json(), key: () => "test-key" },
        async () => {
            calls++
            return null
        }
    )
    const runId = clankhouse.start("test-workflow", null)
    await runOutput(clankhouse, runId)
    age(clankhouse, runId, 15)
    await clankhouse.gc()

    // when the key is started again
    const startedId = clankhouse.start("test-workflow", null)

    // then no new run is created
    expect(startedId).toBe(runId)
    expect(calls).toBe(1)
    expect(count(clankhouse, "runs", "1 = 1")).toBe(1)
    // and run on the same key throws
    await expect(testRun(clankhouse, async () => null)).rejects.toMatchObject({ code: "workflow_run_deleted" })
    // and resume and rerun reject the tombstone
    expect(() => clankhouse.resume(runId)).toThrow(expect.objectContaining({ code: "workflow_run_deleted" }))
    expect(() => clankhouse.rerun(runId, { from: "x" })).toThrow(
        expect.objectContaining({ code: "workflow_run_deleted" })
    )
})

test("a tombstoned failed key makes start and run throw workflow_run_deleted", async () => {
    // given a registered workflow with a deleted failed run and a failed run left deleting
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow(
        "test-workflow",
        { input: z.string(), output: z.json(), key: (key) => key },
        async () => {
            throw new Error("boom")
        }
    )
    const deletedId = clankhouse.start("test-workflow", "deleted")
    const deletingId = clankhouse.start("test-workflow", "deleting")
    await expect(runOutput(clankhouse, deletedId)).rejects.toThrow("boom")
    await expect(runOutput(clankhouse, deletingId)).rejects.toThrow("boom")
    age(clankhouse, deletedId, 15)
    await clankhouse.gc()
    clankhouse.db.prepare("UPDATE runs SET gc_state = 'deleting' WHERE id = ?").run(deletingId)

    // when either key is started again
    // then start reports the deletion instead of the failure
    for (const key of ["deleted", "deleting"]) {
        expect(() => clankhouse.start("test-workflow", key)).toThrow(
            expect.objectContaining({ code: "workflow_run_deleted" })
        )
    }
    // and run on either key reports the deletion
    for (const key of ["deleted", "deleting"]) {
        await expect(testRun(clankhouse, async () => null, { key })).rejects.toMatchObject({
            code: "workflow_run_deleted"
        })
    }
    // and no new attempt is created
    expect(count(clankhouse, "runs", "1 = 1")).toBe(2)
})

test("a rerun's sessions and artifacts survive deletion of the earlier attempt", async () => {
    // given a failed first attempt with an artifact and llm session, rerun from a later step
    const { clankhouse, dir } = tempClankHouse()
    const llm = new FakeLLM(() => ({ summary: "s" }))
    let fail = true
    clankhouse.registerWorkflow(
        "test-workflow",
        { input: z.null(), output: z.json(), key: () => "test-key" },
        async () => {
            await clankhouse.artifacts.writeText("report", "hello")
            await llm.call("summarize", { prompt: "p", output: z.object({ summary: z.string() }) })
            await clankhouse.step("finish", z.null(), async () => {
                if (fail) throw new Error("boom")
                return null
            })
            return null
        }
    )
    const firstId = clankhouse.start("test-workflow", null)
    await expect(runOutput(clankhouse, firstId)).rejects.toThrow("boom")
    fail = false
    const secondId = clankhouse.rerun(firstId, { from: "finish" })
    await runOutput(clankhouse, secondId)
    age(clankhouse, firstId, 15)

    // when garbage collection deletes the first attempt
    const result = await clankhouse.gc()

    // then the rerun keeps its own copies of the session and artifact
    expect(result.runs).toEqual({ deleted: 1 })
    expectRunDataGone(clankhouse, dir, firstId)
    const second = await clankhouse.runs.get(secondId)
    const llmStep = second.steps.find((step) => step.kind === "llm")!
    const session = await clankhouse.sessions.get((llmStep as { sessionId: string }).sessionId)
    expect(session.messages.map((message) => message.type)).toEqual(["message", "message"])
    expect(second.artifacts).toHaveLength(1)
    expect((await clankhouse.artifacts.readText(second.artifacts[0].id)).text).toBe("hello")
})
