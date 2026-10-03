import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { gate, tempClankHouse, testRun } from "@clankhouse/test-utils"
import { expect, onTestFinished, test, vi } from "vitest"
import { serve, type ClankHouseServer } from "../src"
import { freePort, rpcClient } from "./helpers"

const DAY_MS = 24 * 60 * 60 * 1000

async function oldRun(instance: ClankHouse, key: string): Promise<string> {
    await testRun(instance, async () => null, { key })
    const runId = (await instance.runs.list({ key }))[0]!.id
    instance.db
        .prepare("UPDATE runs SET ended_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 15 * DAY_MS).toISOString(), runId)
    return runId
}

function gcState(instance: ClankHouse, runId: string): string | null {
    return (instance.db.prepare("SELECT gc_state FROM runs WHERE id = ?").get(runId) as { gc_state: string | null })
        .gc_state
}

function gatedGc(instance: ClankHouse): { calls: () => number; finished: () => number; release: () => void } {
    const original = instance.gc.bind(instance)
    const gates: ReturnType<typeof gate>[] = []
    const gateAt = (index: number) => (gates[index] ??= gate())
    let calls = 0
    let finished = 0
    let released = 0
    instance.gc = async (options) => {
        await gateAt(calls++).released
        try {
            return await original(options)
        } finally {
            finished++
        }
    }
    return {
        calls: () => calls,
        finished: () => finished,
        release: () => gateAt(released++).release()
    }
}

test("serve collects an eligible old run shortly after startup", async () => {
    // given a run that ended long enough ago to be collected
    const { clankhouse } = tempClankHouse()
    const runId = await oldRun(clankhouse, "old")

    // when the high-level server starts
    const server = await serve(clankhouse, { port: 0 })
    onTestFinished(() => server.close())

    // then the run is collected in the background
    await vi.waitFor(() => expect(gcState(clankhouse, runId)).toBe("deleted"))
})

test("serve with gc disabled leaves an eligible old run in place", async () => {
    // given a run that ended long enough ago to be collected
    const { clankhouse, reopen } = tempClankHouse()
    const runId = await oldRun(clankhouse, "old")

    // when the high-level server starts with gc disabled and is closed again
    const server = await serve(clankhouse, { port: 0, gc: false })
    await server.close()

    // then the run was not collected
    expect(gcState(reopen(), runId)).toBeNull()
})

test("serve passes custom gc options through", async () => {
    // given a run that ended long enough ago to be collected
    const { clankhouse } = tempClankHouse()
    const runId = await oldRun(clankhouse, "old")
    const tracked = gatedGc(clankhouse)
    tracked.release()

    // when the high-level server starts with run deletion disabled
    const server = await serve(clankhouse, { port: 0, gc: { deleteRuns: false } })
    onTestFinished(() => server.close())

    // then the startup gc completes
    await vi.waitFor(() => expect(tracked.finished()).toBe(1))
    // and the run is kept
    expect(gcState(clankhouse, runId)).toBeNull()
})

test("serve rejects invalid gc options before binding", async () => {
    // given a fresh ClankHouse instance and a free port
    const { clankhouse } = tempClankHouse()
    const port = await freePort()

    // when the high-level server is started with an invalid gc threshold
    const outcome = serve(clankhouse, { port, gc: { minAgeDays: 0 } })

    // then startup fails with the validation error
    await expect(outcome).rejects.toThrow(/minAgeDays must be an integer of at least 1/)
    // and the port was never bound
    expect(await freePort(port)).toBe(port)
    // and the instance it took ownership of is closed
    expect(clankhouse.closed).toBe(true)
})

test("serve reports gc errors to onError and keeps serving", async () => {
    // given a ClankHouse instance whose runs table can no longer be read
    const { clankhouse } = tempClankHouse()
    clankhouse.db.exec("DROP TABLE runs")
    const errors: Error[] = []

    // when the high-level server starts without recovery
    const server = await serve(clankhouse, { port: 0, recover: false, onError: (error) => errors.push(error) })
    onTestFinished(() => server.close())

    // then the gc failure is reported to onError
    await vi.waitFor(() => expect(errors).toEqual([expect.objectContaining({ code: "SQLITE_ERROR" })]))
    // and the server still answers requests
    expect((await rpcClient(server).listWorkflows({})).workflows).toEqual(expect.any(Array))
})

test("close waits for an in-progress gc before closing ClankHouse", async () => {
    // given a server whose startup gc is still in progress
    const { clankhouse, reopen } = tempClankHouse()
    const runId = await oldRun(clankhouse, "old")
    const tracked = gatedGc(clankhouse)
    const server = await serve(clankhouse, { port: 0 })
    onTestFinished(() => server.close())
    await vi.waitFor(() => expect(tracked.calls()).toBe(1))

    // when the server is closed
    let closed = false
    const closing = server.close().then(() => {
        closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // then ClankHouse stays open while gc is running
    expect(closed).toBe(false)
    expect(clankhouse.closed).toBe(false)

    // when the gc is allowed to finish
    tracked.release()
    await closing

    // then gc completed before ClankHouse was closed
    expect(tracked.finished()).toBe(1)
    expect(clankhouse.closed).toBe(true)
    // and the old run was collected
    expect(gcState(reopen(), runId)).toBe("deleted")
})

async function serveWithFakeIntervals(instance: ClankHouse): Promise<ClankHouseServer> {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    let server: ClankHouseServer
    try {
        server = await serve(instance, { port: 0 })
    } catch (error) {
        vi.useRealTimers()
        throw error
    }
    onTestFinished(() => {
        vi.useRealTimers()
        return server.close()
    })
    return server
}

test("the gc interval triggers another gc and skips ticks while one is in progress", async () => {
    // given a server with fake interval timers whose gc calls are gated
    const { clankhouse } = tempClankHouse()
    const tracked = gatedGc(clankhouse)
    await serveWithFakeIntervals(clankhouse)
    await vi.waitFor(() => expect(tracked.calls()).toBe(1))

    // when a day passes while the startup gc is still in progress
    vi.advanceTimersByTime(DAY_MS)

    // then the tick is skipped
    expect(tracked.calls()).toBe(1)

    // when the startup gc finishes and another day passes
    tracked.release()
    await vi.waitFor(() => expect(tracked.finished()).toBe(1))
    vi.advanceTimersByTime(DAY_MS)

    // then another gc runs
    expect(tracked.calls()).toBe(2)
    tracked.release()
    await vi.waitFor(() => expect(tracked.finished()).toBe(2))
})

test("close stops the gc interval as soon as it begins", async () => {
    // given a server with fake interval timers whose startup gc has finished
    const { clankhouse } = tempClankHouse()
    const tracked = gatedGc(clankhouse)
    tracked.release()
    const server = await serveWithFakeIntervals(clankhouse)
    await vi.waitFor(() => expect(tracked.finished()).toBe(1))

    // when a day passes while the server is closing
    const closing = server.close()
    vi.advanceTimersByTime(DAY_MS)
    await closing

    // then no further gc was started
    expect(tracked.calls()).toBe(1)
})
