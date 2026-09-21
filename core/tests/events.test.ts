import * as z from "zod"
import { expect, expectTypeOf, test } from "vitest"
import { ClankHouse } from "@clankhouse/core/clankhouse"
import type { EventSourceListener } from "@clankhouse/core/events"
import { gate, runOutput, tempClankHouse, testRun } from "@clankhouse/test-utils"

const approval = z.object({ ok: z.boolean() })
const workflowOptions = { input: z.null(), output: z.json(), key: () => "test-key" }

test("waitFor receives an emitted event and records an event step", async () => {
    // given a fresh clankhouse instance and a synchronization gate
    const { clankhouse } = tempClankHouse()
    const waiting = gate()
    // when a workflow waits for an "approval" event
    const promise = testRun(clankhouse, async () => {
        waiting.release()
        const event = await clankhouse.waitFor({ key: "approval", schema: approval })
        return event.ok
    })
    await waiting.released
    // and the event is emitted
    await clankhouse.emit("approval", { ok: true })
    // then the workflow resolves with the event payload
    expect(await promise).toBe(true)
    // and the event is persisted in the events table
    const rows = clankhouse.db.prepare("SELECT key, payload FROM events").all() as {
        key: string
        payload: string
    }[]
    expect(rows.map((r) => ({ key: r.key, payload: JSON.parse(r.payload) }))).toEqual([
        { key: "approval", payload: { ok: true } }
    ])
    // and the run records a single event step
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
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
    const { clankhouse } = tempClankHouse()
    const waiting = gate()
    let stops = 0
    const promise = testRun(clankhouse, async () => {
        waiting.release()
        return clankhouse.waitFor({
            key: "approval",
            schema: approval,
            start: () => ({ stop: () => stops++ })
        })
    })
    await waiting.released
    // when an event is emitted with a payload that violates the schema
    await clankhouse.emit("approval", { ok: "nope" })
    // then the wait rejects with a schema validation error
    await expect(promise).rejects.toMatchObject({
        message: expect.stringMatching(/schema validation/),
        code: "event_schema_validation_failed"
    })
    // and the active source is stopped
    expect(stops).toBe(1)
    // and the run is marked as failed
    expect((await clankhouse.runs.list())[0].status).toBe("failed")
})

test("emitting an undefined payload rejects with a coded error and persists nothing", async () => {
    // given a fresh clankhouse instance
    const { clankhouse } = tempClankHouse()
    // when an event is emitted without a JSON-serializable payload
    const promise = clankhouse.emit("approval", undefined)
    // then the emit rejects with the event_payload_required code
    await expect(promise).rejects.toMatchObject({ code: "event_payload_required" })
    // and no event is written to the events table
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 })
})

test("waitForAny resolves with the first matching event", async () => {
    // given a workflow waiting for either of two event sources
    const { clankhouse } = tempClankHouse()
    const waiting = gate()
    const promise = testRun(clankhouse, async () => {
        waiting.release()
        return clankhouse.waitForAny([
            { key: "a", schema: z.object({ n: z.number() }) },
            { key: "b", schema: z.object({ s: z.string() }) }
        ])
    })
    await waiting.released
    // when only the "b" event is emitted
    await clankhouse.emit("b", { s: "hi" })
    // then the wait resolves with the "b" event's key and payload
    expect(await promise).toEqual({ key: "b", event: { s: "hi" } })
    // and the run records a wait step keyed by both event names
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    expect(run.steps[0].key).toBe("wait:a+b")
})

test("waitForAny infers a keyed union of source outputs", async () => {
    // given a stored event matching one of two differently typed sources
    const { clankhouse } = tempClankHouse()
    await clankhouse.emit("typed-text", "ready")

    // when a workflow waits for either source
    const promise = testRun(clankhouse, async () =>
        clankhouse.waitForAny([
            { key: "typed-number", schema: z.number() },
            { key: "typed-text", schema: z.string() }
        ])
    )

    // then its promise retains the key-discriminated output union
    expectTypeOf(promise).toEqualTypeOf<
        Promise<{ key: "typed-number"; event: number } | { key: "typed-text"; event: string }>
    >()
    // and the runtime result preserves the winning envelope
    expect(await promise).toEqual({ key: "typed-text", event: "ready" })
})

test.each(["api", "active"] as const)("waitForAny accepts a mixed set resolved by the %s source", async (kind) => {
    // given an API source and an active source in the same wait
    const { clankhouse } = tempClankHouse()
    const started = gate()
    let listener: EventSourceListener<string> | undefined
    let stops = 0
    const promise = testRun(clankhouse, async () =>
        clankhouse.waitForAny([
            { key: "manual", schema: z.number() },
            {
                key: "observed",
                schema: z.string(),
                start(value) {
                    listener = value
                    started.release()
                    return { stop: () => stops++ }
                }
            }
        ])
    )
    await started.released

    // when one of the sources supplies an event
    if (kind === "api") await clankhouse.emit("manual", 7)
    else listener?.emit("ready")

    // then the result retains both typed variants and the active source is stopped
    expectTypeOf(promise).toEqualTypeOf<
        Promise<{ key: "manual"; event: number } | { key: "observed"; event: string }>
    >()
    expect(await promise).toEqual(kind === "api" ? { key: "manual", event: 7 } : { key: "observed", event: "ready" })
    expect(stops).toBe(1)
})

test("waitForAny requires at least one source", async () => {
    // given a fresh clankhouse instance
    const { clankhouse } = tempClankHouse()
    // when a workflow calls waitForAny with no event sources
    // then it rejects requiring at least one source
    await expect(testRun(clankhouse, async () => clankhouse.waitForAny([]))).rejects.toMatchObject({
        message: expect.stringMatching(/at least one/),
        code: "event_sources_empty"
    })
})

test("an invalid event schema fails before a step or waiter is registered", async () => {
    // given an event wait whose payload schema is not JSON-compatible
    const { clankhouse } = tempClankHouse()

    // when the invalid wait is set up
    const invalid = testRun(clankhouse, async () => clankhouse.waitFor({ key: "go", schema: z.date() }), {
        key: "invalid"
    })

    // then it fails before creating the durable step
    await expect(invalid).rejects.toThrow(/Event "go" payload schema.*z\.date/)
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM steps").get()).toEqual({ n: 0 })
    // and the key remains available for a valid waiter
    const valid = testRun(clankhouse, async () => clankhouse.waitFor({ key: "go", schema: z.string() }), {
        key: "valid"
    })
    await clankhouse.emit("go", "ready")
    expect(await valid).toBe("ready")
})

test("a second wait on an already-waited key is rejected", async () => {
    // given a workflow already waiting on the "go" event key
    const { clankhouse } = tempClankHouse()
    const waiting = gate()
    const first = testRun(
        clankhouse,
        async () => {
            waiting.release()
            return (await clankhouse.waitFor({ key: "go", schema: z.object({ n: z.number() }) })).n
        },
        { key: "key-1" }
    )
    await waiting.released
    // when a second workflow waits on the same key
    const second = testRun(
        clankhouse,
        async () => (await clankhouse.waitFor({ key: "go", schema: z.object({ n: z.number() }) })).n,
        {
            key: "key-2"
        }
    )
    // then the second wait rejects
    await expect(second).rejects.toMatchObject({
        message: expect.stringMatching(/already registered/),
        code: "event_wait_already_registered"
    })
    // and the second run is marked as failed
    expect((await clankhouse.runs.list({ key: "key-2" }))[0].status).toBe("failed")
    // and when the event is emitted
    await clankhouse.emit("go", { n: 5 })
    // then the first waiter still receives it
    expect(await first).toBe(5)
})

test("emit without waiters still persists the event", async () => {
    // given a fresh clankhouse instance with no waiters registered
    const { clankhouse } = tempClankHouse()
    // when an event is emitted for a key nobody is waiting on
    await clankhouse.emit("nobody", { x: 1 })
    // then the event is still persisted
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 })
})

test("a received event is replayed deterministically on resume", async () => {
    // given a workflow body that transforms a raw "approval" event then blocks
    const { clankhouse, reopen } = tempClankHouse()
    const parked = gate()
    const waiting = gate()
    const received = gate()
    let transforms = 0
    let starts = 0
    let stops = 0
    const transformedApproval = approval.transform((event) => {
        transforms++
        return { ok: !event.ok }
    })
    const body = (l: ClankHouse, block: boolean) => async () => {
        waiting.release()
        const event = await l.waitFor({
            key: "approval",
            schema: transformedApproval,
            start: () => {
                starts++
                return { stop: () => stops++ }
            }
        })
        received.release()
        if (block) await parked.released
        return event.ok
    }
    // when the first run waits for and receives the event, then parks
    testRun(clankhouse, body(clankhouse, true)).catch(() => {})
    await waiting.released
    await clankhouse.emit("approval", { ok: true })
    await received.released
    // and the process is reopened, replaying the workflow
    const second = reopen()
    // then the resumed run transforms the persisted raw envelope once without compounding
    expect(await testRun(second, body(second, false))).toBe(false)
    expect(transforms).toBe(2)
    expect(starts).toBe(1)
    expect(stops).toBe(1)
    const run = await second.runs.get((await second.runs.list())[0].id)
    expect(run.steps[0].outputJson).toBe(JSON.stringify({ key: "approval", event: { ok: true } }))
    // and the event was not duplicated in the store
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 })
})

test("an event emitted before the wait is delivered from the store", async () => {
    // given an event emitted before any workflow waits for it
    const { clankhouse } = tempClankHouse()
    await clankhouse.emit("go", { n: 4 })
    // when a workflow waits for that event
    const result = await testRun(
        clankhouse,
        async () => (await clankhouse.waitFor({ key: "go", schema: z.object({ n: z.number() }) })).n
    )
    // then it is delivered immediately from the stored events
    expect(result).toBe(4)
})

test("an event emitted while the process is down is delivered on resume", async () => {
    // given a workflow parked waiting for a "go" event
    const { clankhouse, reopen } = tempClankHouse()
    const waiting = gate()
    testRun(clankhouse, async () => {
        waiting.release()
        return (await clankhouse.waitFor({ key: "go", schema: z.object({ n: z.number() }) })).n
    }).catch(() => {})
    await waiting.released
    // when the process is reopened and the event is emitted while nothing is running
    const second = reopen()
    await second.emit("go", { n: 9 })
    // and a new run waits for the same event
    const result = await testRun(
        second,
        async () => (await second.waitFor({ key: "go", schema: z.object({ n: z.number() }) })).n
    )
    // then it is delivered from the store
    expect(result).toBe(9)
})

test("a consumed event is not delivered to later waits", async () => {
    // given a "go" event emitted before any waiter
    const { clankhouse } = tempClankHouse()
    await clankhouse.emit("go", { n: 1 })
    // when the first run waits for the event
    // then it consumes the previously emitted event
    expect(
        await testRun(
            clankhouse,
            async () => (await clankhouse.waitFor({ key: "go", schema: z.object({ n: z.number() }) })).n,
            {
                key: "key-1"
            }
        )
    ).toBe(1)
    // and when a second run waits on the same key
    const promise = testRun(
        clankhouse,
        async () => (await clankhouse.waitFor({ key: "go", schema: z.object({ n: z.number() }) })).n,
        {
            key: "key-2"
        }
    )
    // and a new event is emitted
    await clankhouse.emit("go", { n: 2 })
    // then the second run receives only the new event
    expect(await promise).toBe(2)
})

test("emit inside a workflow body is a durable step and is not repeated on resume", async () => {
    // given a workflow body that emits a "done" event then blocks
    const { clankhouse, reopen } = tempClankHouse()
    const parked = gate()
    const reached = gate()
    const body = (l: ClankHouse, block: boolean) => async () => {
        await l.emit("done", { ok: true })
        reached.release()
        if (block) await parked.released
        return null
    }
    // when the first run emits the event and then parks
    testRun(clankhouse, body(clankhouse, true)).catch(() => {})
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
    const { clankhouse, reopen } = tempClankHouse()
    const parked = gate()
    const waiting = gate()
    const received = gate()
    testRun(clankhouse, async () => {
        waiting.release()
        const event = await clankhouse.waitFor({ key: "go", schema: z.object({ n: z.number() }) })
        received.release()
        await parked.released
        return event.n
    }).catch(() => {})
    await waiting.released
    // when the event is emitted and received by the workflow
    await clankhouse.emit("go", { n: 7 })
    await received.released
    // and the wait step is forced back into an interrupted state, simulating a crash before it persisted
    clankhouse.db
        .prepare("UPDATE steps SET status = 'interrupted', output = NULL, ended_at = NULL WHERE key = ?")
        .run("wait:go")
    // and the process is reopened
    const second = reopen()
    // then the wait is redelivered the same event on resume
    const result = await testRun(
        second,
        async () => (await second.waitFor({ key: "go", schema: z.object({ n: z.number() }) })).n
    )
    expect(result).toBe(7)
    // and the event was not duplicated in the store
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 })
})

test("an event payload preserves an ISO datetime string for the waiter", async () => {
    // given a workflow waiting for an event whose schema expects an ISO datetime string
    const { clankhouse } = tempClankHouse()
    const waiting = gate()
    const at = "2026-07-07T12:00:00.000Z"
    const promise = testRun(clankhouse, async () => {
        waiting.release()
        const event = await clankhouse.waitFor({
            key: "scheduled",
            schema: z.object({ at: z.iso.datetime() })
        })
        return event.at
    })
    await waiting.released
    // when the event is emitted carrying the ISO string
    await clankhouse.emit("scheduled", { at })
    // then the waiter receives the same JSON string
    expect(await promise).toBe(at)
})

test("re-emitting on rerun supersedes the previous unconsumed event", async () => {
    // given a workflow that emits a "result" event then runs a publish step that first fails
    const { clankhouse } = tempClankHouse()
    let value = 1
    let publishImpl: () => string = () => {
        throw new Error("boom")
    }
    const body = async () => {
        await clankhouse.emit("result", { v: value })
        return clankhouse.step("publish", z.string(), async () => publishImpl())
    }
    clankhouse.registerWorkflow("test-workflow", workflowOptions, body)
    // when the first attempt emits result=1 and the publish step throws
    const firstId = clankhouse.start("test-workflow", null)
    await expect(runOutput(clankhouse, firstId)).rejects.toThrow("boom")
    // then a single unconsumed "result" event is stored
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM events WHERE key = 'result'").get()).toEqual({ n: 1 })
    // and when the workflow reruns from the emit step with a corrected value and a working publish
    value = 2
    publishImpl = () => "published"
    const secondId = clankhouse.rerun(firstId, { from: "emit:result" })
    expect(await runOutput(clankhouse, secondId)).toBe("published")
    // then the stale event was superseded, leaving a single "result" event in the store
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM events WHERE key = 'result'").get()).toEqual({ n: 1 })
    // and a later consumer receives the corrected payload rather than the stale one
    const received = await testRun(
        clankhouse,
        async () => (await clankhouse.waitFor({ key: "result", schema: z.object({ v: z.number() }) })).v,
        {
            key: "consumer"
        }
    )
    expect(received).toBe(2)
})

test("a crash while waiting re-registers the wait on resume", async () => {
    // given a workflow body that waits for a "go" event
    const { clankhouse, reopen } = tempClankHouse()
    const body = (l: ClankHouse, waiting: { release: () => void }) => async () => {
        waiting.release()
        return (await l.waitFor({ key: "go", schema: z.object({ n: z.number() }) })).n
    }
    // when the first run starts waiting and then the process crashes
    const firstWaiting = gate()
    testRun(clankhouse, body(clankhouse, firstWaiting)).catch(() => {})
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

test("a source can synchronously emit while starting", async () => {
    // given an active source that emits synchronously during startup
    const { clankhouse } = tempClankHouse()
    let stops = 0
    const source = {
        key: "sync",
        schema: z.object({ n: z.number() }),
        start(listener: EventSourceListener<{ n: number }>) {
            listener.emit({ n: 3 })
            return { stop: () => stops++ }
        }
    }

    // when a workflow waits for the source
    const result = await testRun(clankhouse, async () => (await clankhouse.waitFor(source)).n)

    // then the emitted event resolves durably
    expect(result).toBe(3)
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM events WHERE key = 'sync'").get()).toEqual({ n: 1 })
    // and the handle returned after settlement is still stopped
    expect(stops).toBe(1)
})

test("waitForAny stops every source when one emits", async () => {
    // given two active event sources
    const { clankhouse } = tempClankHouse()
    const started = gate()
    const listeners: EventSourceListener<string>[] = []
    const stops = [0, 0]
    const source = (key: string, index: number) => ({
        key,
        schema: z.string(),
        start(listener: EventSourceListener<string>) {
            listeners.push(listener)
            if (listeners.length === 2) started.release()
            return { stop: () => stops[index]++ }
        }
    })
    const promise = testRun(clankhouse, async () => clankhouse.waitForAny([source("first", 0), source("second", 1)]))
    await started.released

    // when the second source emits
    listeners[1].emit("ready")

    // then its envelope is returned
    expect(await promise).toEqual({ key: "second", event: "ready" })
    // and both source handles are stopped
    expect(stops).toEqual([1, 1])
})

test("manual emit stops an active source", async () => {
    // given a workflow waiting on an active source
    const { clankhouse } = tempClankHouse()
    const started = gate()
    let stops = 0
    const source = {
        key: "manual",
        schema: z.number(),
        start() {
            started.release()
            return { stop: () => stops++ }
        }
    }
    const promise = testRun(clankhouse, async () => clankhouse.waitFor(source))
    await started.released

    // when the same key is satisfied through emit
    await clankhouse.emit(source.key, 8)

    // then the wait resolves and its source is stopped
    expect(await promise).toBe(8)
    expect(stops).toBe(1)
})

test("a source failure rejects the wait and stops its handle", async () => {
    // given a source that fails synchronously while starting
    const { clankhouse } = tempClankHouse()
    let stops = 0
    const source = {
        key: "failed-source",
        schema: z.string(),
        start(listener: EventSourceListener<string>) {
            listener.fail(new Error("source failed"))
            return { stop: () => stops++ }
        }
    }

    // when a workflow waits for the source
    const promise = testRun(clankhouse, async () => clankhouse.waitFor(source))

    // then the source error fails the wait
    await expect(promise).rejects.toThrow("source failed")
    // and its synchronously returned handle is stopped
    expect(stops).toBe(1)
})

test("a later source startup failure stops earlier sources", async () => {
    // given one started source followed by a source that throws during startup
    const { clankhouse } = tempClankHouse()
    let stops = 0
    const sources = [
        {
            key: "started",
            schema: z.string(),
            start: () => ({ stop: () => stops++ })
        },
        {
            key: "throws",
            schema: z.string(),
            start: () => {
                throw new Error("startup failed")
            }
        }
    ]

    // when a workflow waits for either source
    const promise = testRun(clankhouse, async () => clankhouse.waitForAny(sources))

    // then the startup error rejects the wait
    await expect(promise).rejects.toThrow("startup failed")
    // and the earlier handle is stopped
    expect(stops).toBe(1)
})

test("a stored event is delivered without starting its source", async () => {
    // given an event stored before an active source is awaited
    const { clankhouse } = tempClankHouse()
    await clankhouse.emit("stored", "ready")
    let starts = 0
    const source = {
        key: "stored",
        schema: z.string(),
        start: () => {
            starts++
            return { stop() {} }
        }
    }

    // when a workflow waits for the source
    const result = await testRun(clankhouse, async () => clankhouse.waitFor(source))

    // then the persisted event is returned without starting the listener
    expect(result).toBe("ready")
    expect(starts).toBe(0)
})

test("closing ClankHouse stops active sources without settling their waits", async () => {
    // given a pending wait with an active source
    const { clankhouse } = tempClankHouse()
    const started = gate()
    let listener: EventSourceListener<string> | undefined
    let stops = 0
    let settled = false
    const promise = testRun(clankhouse, async () =>
        clankhouse.waitFor({
            key: "shutdown",
            schema: z.string(),
            start(value) {
                listener = value
                started.release()
                return { stop: () => stops++ }
            }
        })
    )
    void promise.then(
        () => {
            settled = true
        },
        () => {
            settled = true
        }
    )
    await started.released

    // when the instance is closed twice and the source emits afterward
    clankhouse.close()
    clankhouse.close()
    listener?.emit("late")
    await Promise.resolve()

    // then the source is stopped once and the durable wait remains interrupted
    expect(stops).toBe(1)
    expect(settled).toBe(false)
})
