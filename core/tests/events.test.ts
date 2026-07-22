import * as z from "zod"
import { expect, test } from "vitest"
import { Loopy } from "@loopy/core/loopy"
import { gate, runOutput, tempLoopy, testRun } from "@loopy/test-utils"

const approval = z.object({ ok: z.boolean() })
const workflowOptions = { input: z.null(), output: z.json(), key: () => "test-key" }

test("waitFor receives an emitted event and records an event step", async () => {
    // given a fresh loopy instance and a synchronization gate
    const { loopy } = tempLoopy()
    const waiting = gate()
    // when a workflow waits for an "approval" event
    const promise = testRun(loopy, async () => {
        waiting.release()
        const event = await loopy.waitFor("approval", approval)
        return event.ok
    })
    await waiting.released
    // and the event is emitted
    await loopy.emit("approval", { ok: true })
    // then the workflow resolves with the event payload
    expect(await promise).toBe(true)
    // and the event is persisted in the events table
    const rows = loopy.db.prepare("SELECT key, payload FROM events").all() as {
        key: string
        payload: string
    }[]
    expect(rows.map((r) => ({ key: r.key, payload: JSON.parse(r.payload) }))).toEqual([
        { key: "approval", payload: { ok: true } }
    ])
    // and the run records a single event step
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.kind).toBe("event")
    expect(step.key).toBe("wait:approval")
    // and the step records the matched event key and output
    if (step.kind === "event") {
        expect(step.eventKey).toBe("approval")
        expect(step.output).toEqual({ key: "approval", event: { ok: true } })
    }
})

test("schema violation rejects the wait and fails the run", async () => {
    // given a workflow waiting for an "approval" event matching a schema
    const { loopy } = tempLoopy()
    const waiting = gate()
    const promise = testRun(loopy, async () => {
        waiting.release()
        return loopy.waitFor("approval", approval)
    })
    await waiting.released
    // when an event is emitted with a payload that violates the schema
    await loopy.emit("approval", { ok: "nope" })
    // then the wait rejects with a schema validation error
    await expect(promise).rejects.toMatchObject({
        message: expect.stringMatching(/schema validation/),
        code: "event_schema_validation_failed"
    })
    // and the run is marked as failed
    expect((await loopy.runs.list())[0].status).toBe("failed")
})

test("emitting an undefined payload rejects with a coded error and persists nothing", async () => {
    // given a fresh loopy instance
    const { loopy } = tempLoopy()
    // when an event is emitted without a JSON-serializable payload
    const promise = loopy.emit("approval", undefined)
    // then the emit rejects with the event_payload_required code
    await expect(promise).rejects.toMatchObject({ code: "event_payload_required" })
    // and no event is written to the events table
    expect(loopy.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 })
})

test("waitForAny resolves with the first matching event", async () => {
    // given a workflow waiting for either of two events
    const { loopy } = tempLoopy()
    const waiting = gate()
    const promise = testRun(loopy, async () => {
        waiting.release()
        return loopy.waitForAny([
            { key: "a", schema: z.object({ n: z.number() }) },
            { key: "b", schema: z.object({ s: z.string() }) }
        ])
    })
    await waiting.released
    // when only the "b" event is emitted
    await loopy.emit("b", { s: "hi" })
    // then the wait resolves with the "b" event's key and payload
    expect(await promise).toEqual({ key: "b", event: { s: "hi" } })
    // and the run records a wait step keyed by both event names
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    expect(run.steps[0].key).toBe("wait:a+b")
})

test("waitForAny requires at least one definition", async () => {
    // given a fresh loopy instance
    const { loopy } = tempLoopy()
    // when a workflow calls waitForAny with no event definitions
    // then it rejects requiring at least one definition
    await expect(testRun(loopy, async () => loopy.waitForAny([]))).rejects.toMatchObject({
        message: expect.stringMatching(/at least one/),
        code: "event_definitions_empty"
    })
})

test("an invalid event schema fails before a step or waiter is registered", async () => {
    // given an event wait whose payload schema is not JSON-compatible
    const { loopy } = tempLoopy()

    // when the invalid wait is set up
    const invalid = testRun(loopy, async () => loopy.waitFor("go", z.date()), { key: "invalid" })

    // then it fails before creating the durable step
    await expect(invalid).rejects.toThrow(/Event "go" payload schema.*z\.date/)
    expect(loopy.db.prepare("SELECT COUNT(*) AS n FROM steps").get()).toEqual({ n: 0 })
    // and the key remains available for a valid waiter
    const valid = testRun(loopy, async () => loopy.waitFor("go", z.string()), { key: "valid" })
    await loopy.emit("go", "ready")
    expect(await valid).toBe("ready")
})

test("a second wait on an already-waited key is rejected", async () => {
    // given a workflow already waiting on the "go" event key
    const { loopy } = tempLoopy()
    const waiting = gate()
    const first = testRun(
        loopy,
        async () => {
            waiting.release()
            return (await loopy.waitFor("go", z.object({ n: z.number() }))).n
        },
        { key: "key-1" }
    )
    await waiting.released
    // when a second workflow waits on the same key
    const second = testRun(loopy, async () => (await loopy.waitFor("go", z.object({ n: z.number() }))).n, {
        key: "key-2"
    })
    // then the second wait rejects
    await expect(second).rejects.toMatchObject({
        message: expect.stringMatching(/already registered/),
        code: "event_wait_already_registered"
    })
    // and the second run is marked as failed
    expect((await loopy.runs.list({ key: "key-2" }))[0].status).toBe("failed")
    // and when the event is emitted
    await loopy.emit("go", { n: 5 })
    // then the first waiter still receives it
    expect(await first).toBe(5)
})

test("emit without waiters still persists the event", async () => {
    // given a fresh loopy instance with no waiters registered
    const { loopy } = tempLoopy()
    // when an event is emitted for a key nobody is waiting on
    await loopy.emit("nobody", { x: 1 })
    // then the event is still persisted
    expect(loopy.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 })
})

test("a received event is replayed deterministically on resume", async () => {
    // given a workflow body that transforms a raw "approval" event then blocks
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const waiting = gate()
    const received = gate()
    let transforms = 0
    const transformedApproval = approval.transform((event) => {
        transforms++
        return { ok: !event.ok }
    })
    const body = (l: Loopy, block: boolean) => async () => {
        waiting.release()
        const event = await l.waitFor("approval", transformedApproval)
        received.release()
        if (block) await parked.released
        return event.ok
    }
    // when the first run waits for and receives the event, then parks
    testRun(loopy, body(loopy, true)).catch(() => {})
    await waiting.released
    await loopy.emit("approval", { ok: true })
    await received.released
    // and the process is reopened, replaying the workflow
    const second = reopen()
    // then the resumed run transforms the persisted raw envelope once without compounding
    expect(await testRun(second, body(second, false))).toBe(false)
    expect(transforms).toBe(2)
    const run = await second.runs.get((await second.runs.list())[0].id)
    expect(run.steps[0].outputJson).toBe(JSON.stringify({ key: "approval", event: { ok: true } }))
    // and the event was not duplicated in the store
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 })
})

test("an event emitted before the wait is delivered from the store", async () => {
    // given an event emitted before any workflow waits for it
    const { loopy } = tempLoopy()
    await loopy.emit("go", { n: 4 })
    // when a workflow waits for that event
    const result = await testRun(loopy, async () => (await loopy.waitFor("go", z.object({ n: z.number() }))).n)
    // then it is delivered immediately from the stored events
    expect(result).toBe(4)
})

test("an event emitted while the process is down is delivered on resume", async () => {
    // given a workflow parked waiting for a "go" event
    const { loopy, reopen } = tempLoopy()
    const waiting = gate()
    testRun(loopy, async () => {
        waiting.release()
        return (await loopy.waitFor("go", z.object({ n: z.number() }))).n
    }).catch(() => {})
    await waiting.released
    // when the process is reopened and the event is emitted while nothing is running
    const second = reopen()
    await second.emit("go", { n: 9 })
    // and a new run waits for the same event
    const result = await testRun(second, async () => (await second.waitFor("go", z.object({ n: z.number() }))).n)
    // then it is delivered from the store
    expect(result).toBe(9)
})

test("a consumed event is not delivered to later waits", async () => {
    // given a "go" event emitted before any waiter
    const { loopy } = tempLoopy()
    await loopy.emit("go", { n: 1 })
    // when the first run waits for the event
    // then it consumes the previously emitted event
    expect(
        await testRun(loopy, async () => (await loopy.waitFor("go", z.object({ n: z.number() }))).n, { key: "key-1" })
    ).toBe(1)
    // and when a second run waits on the same key
    const promise = testRun(loopy, async () => (await loopy.waitFor("go", z.object({ n: z.number() }))).n, {
        key: "key-2"
    })
    // and a new event is emitted
    await loopy.emit("go", { n: 2 })
    // then the second run receives only the new event
    expect(await promise).toBe(2)
})

test("emit inside a workflow body is a durable step and is not repeated on resume", async () => {
    // given a workflow body that emits a "done" event then blocks
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    const body = (l: Loopy, block: boolean) => async () => {
        await l.emit("done", { ok: true })
        reached.release()
        if (block) await parked.released
        return null
    }
    // when the first run emits the event and then parks
    testRun(loopy, body(loopy, true)).catch(() => {})
    await reached.released
    // and the process is reopened, replaying the workflow to completion
    const second = reopen()
    await testRun(second, body(second, false))
    // then the event is persisted only once despite the replay
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 })
    // and the run records a single succeeded emit step
    const run = await second.runs.get((await second.runs.list())[0].id)
    expect(run.steps.map((s) => [s.key, s.kind, s.status])).toEqual([["emit:done", "event", "succeeded"]])
})

test("an event consumed before the wait step persisted is redelivered on resume", async () => {
    // given a workflow that receives a "go" event and then blocks before returning
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const waiting = gate()
    const received = gate()
    testRun(loopy, async () => {
        waiting.release()
        const event = await loopy.waitFor("go", z.object({ n: z.number() }))
        received.release()
        await parked.released
        return event.n
    }).catch(() => {})
    await waiting.released
    // when the event is emitted and received by the workflow
    await loopy.emit("go", { n: 7 })
    await received.released
    // and the wait step is forced back into an interrupted state, simulating a crash before it persisted
    loopy.db
        .prepare("UPDATE steps SET status = 'interrupted', output = NULL, ended_at = NULL WHERE key = ?")
        .run("wait:go")
    // and the process is reopened
    const second = reopen()
    // then the wait is redelivered the same event on resume
    const result = await testRun(second, async () => (await second.waitFor("go", z.object({ n: z.number() }))).n)
    expect(result).toBe(7)
    // and the event was not duplicated in the store
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 })
})

test("an event payload preserves an ISO datetime string for the waiter", async () => {
    // given a workflow waiting for an event whose schema expects an ISO datetime string
    const { loopy } = tempLoopy()
    const waiting = gate()
    const at = "2026-07-07T12:00:00.000Z"
    const promise = testRun(loopy, async () => {
        waiting.release()
        const event = await loopy.waitFor("scheduled", z.object({ at: z.iso.datetime() }))
        return event.at
    })
    await waiting.released
    // when the event is emitted carrying the ISO string
    await loopy.emit("scheduled", { at })
    // then the waiter receives the same JSON string
    expect(await promise).toBe(at)
})

test("re-emitting on rerun supersedes the previous unconsumed event", async () => {
    // given a workflow that emits a "result" event then runs a publish step that first fails
    const { loopy } = tempLoopy()
    let value = 1
    let publishImpl: () => string = () => {
        throw new Error("boom")
    }
    const body = async () => {
        await loopy.emit("result", { v: value })
        return loopy.step("publish", z.string(), async () => publishImpl())
    }
    loopy.registerWorkflow("test-workflow", workflowOptions, body)
    // when the first attempt emits result=1 and the publish step throws
    const firstId = loopy.start("test-workflow", null)
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    // then a single unconsumed "result" event is stored
    expect(loopy.db.prepare("SELECT COUNT(*) AS n FROM events WHERE key = 'result'").get()).toEqual({ n: 1 })
    // and when the workflow reruns from the emit step with a corrected value and a working publish
    value = 2
    publishImpl = () => "published"
    const secondId = loopy.rerun(firstId, { from: "emit:result" })
    expect(await runOutput(loopy, secondId)).toBe("published")
    // then the stale event was superseded, leaving a single "result" event in the store
    expect(loopy.db.prepare("SELECT COUNT(*) AS n FROM events WHERE key = 'result'").get()).toEqual({ n: 1 })
    // and a later consumer receives the corrected payload rather than the stale one
    const received = await testRun(loopy, async () => (await loopy.waitFor("result", z.object({ v: z.number() }))).v, {
        key: "consumer"
    })
    expect(received).toBe(2)
})

test("a crash while waiting re-registers the wait on resume", async () => {
    // given a workflow body that waits for a "go" event
    const { loopy, reopen } = tempLoopy()
    const body = (l: Loopy, waiting: { release: () => void }) => async () => {
        waiting.release()
        return (await l.waitFor("go", z.object({ n: z.number() }))).n
    }
    // when the first run starts waiting and then the process crashes
    const firstWaiting = gate()
    testRun(loopy, body(loopy, firstWaiting)).catch(() => {})
    await firstWaiting.released
    // and the process is reopened, resuming the run and re-registering the wait
    const second = reopen()
    const secondWaiting = gate()
    const promise = testRun(second, body(second, secondWaiting))
    await secondWaiting.released
    // and the event is emitted after resume
    await second.emit("go", { n: 9 })
    // then the resumed wait receives the event
    expect(await promise).toBe(9)
})
