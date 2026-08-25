import * as z from "zod"
import { expect, expectTypeOf, onTestFinished, test, vi } from "vitest"
import { ClankHouse } from "@clankhouse/core/clankhouse"
import type { EventSource, EventSourceListener } from "@clankhouse/core/events"
import {
    Triggers,
    type TriggerArguments,
    type TriggerErrorHandler,
    type TriggerHandle,
    type TriggerOptions
} from "@clankhouse/core/triggers"
import type { WorkflowRef } from "@clankhouse/core/workflows"
import { gate, runOutput, tempClankHouse, tempDir } from "@clankhouse/test-utils"

function configuredClankHouse(onTriggerError: TriggerErrorHandler): ClankHouse {
    const clankhouse = new ClankHouse(tempDir("clankhouse-trigger-errors-"), { onTriggerError })
    onTestFinished(() => clankhouse.close())
    return clankhouse
}

function controlledSource<T extends z.ZodTypeAny>(key: string, schema: T) {
    let listener: EventSourceListener<z.input<T>> | undefined
    let starts = 0
    let stops = 0
    const source: EventSource<T> = {
        key,
        schema,
        start(value) {
            starts++
            listener = value
            return { stop: () => stops++ }
        }
    }
    return {
        source,
        emit(event: z.input<T>) {
            if (!listener) throw new Error("Source has not started")
            listener.emit(event)
        },
        fail(error: unknown) {
            if (!listener) throw new Error("Source has not started")
            listener.fail(error)
        },
        starts: () => starts,
        stops: () => stops
    }
}

test("a compatible event starts a workflow directly for every emission", async () => {
    // given a registered workflow and a matching active event source
    const { clankhouse } = tempClankHouse()
    const input = z.object({ id: z.string(), value: z.number() })
    const workflow = clankhouse.registerWorkflow(
        "direct-trigger",
        { input, output: z.number(), key: (value) => value.id },
        async (value) => value.value * 2
    )
    const source = controlledSource("direct", input)

    // when two events are emitted through the source
    const handle = clankhouse.addTrigger(source.source, workflow)
    source.emit({ id: "first", value: 2 })
    source.emit({ id: "second", value: 3 })

    // then each event starts its independently keyed workflow run
    const first = (await clankhouse.runs.list({ workflowName: "direct-trigger", key: "first" }))[0]
    const second = (await clankhouse.runs.list({ workflowName: "direct-trigger", key: "second" }))[0]
    expect(await runOutput(clankhouse, first.id)).toBe(4)
    expect(await runOutput(clankhouse, second.id)).toBe(6)
    // and the returned handle stops the long-lived source idempotently
    handle.stop()
    handle.stop()
    expect(source.stops()).toBe(1)
})

test("a trigger parses and transforms an event before mapping it to workflow input", async () => {
    // given an event source with a transform and a workflow requiring a different input shape
    const { clankhouse } = tempClankHouse()
    const workflow = clankhouse.registerWorkflow(
        "mapped-trigger",
        {
            input: z.object({ id: z.string(), value: z.number() }),
            output: z.number(),
            key: (value) => value.id
        },
        async (value) => value.value
    )
    const source = controlledSource(
        "mapped",
        z.object({ requestId: z.string(), text: z.string() }).transform((event) => ({
            requestId: event.requestId,
            value: Number(event.text)
        }))
    )
    let mappedEvent: { requestId: string; value: number } | undefined
    clankhouse.addTrigger(source.source, workflow, {
        eventToInput: (event) => {
            mappedEvent = event
            return { id: event.requestId, value: event.value }
        }
    })

    // when the source emits its raw input value
    source.emit({ requestId: "request-1", text: "7" })

    // then the mapper sees the transformed output and the workflow receives its mapped input
    expect(mappedEvent).toEqual({ requestId: "request-1", value: 7 })
    const run = (await clankhouse.runs.list({ workflowName: "mapped-trigger", key: "request-1" }))[0]
    expect(await runOutput(clankhouse, run.id)).toBe(7)
})

test("trigger APIs retain workflow input compatibility and mapper inference", () => {
    // given refs and event sources with compatible and incompatible output types
    const { clankhouse } = tempClankHouse()
    const input = z.object({ id: z.string(), value: z.number() })
    const workflow = clankhouse.registerWorkflow(
        "typed-trigger",
        {
            input,
            output: z.void(),
            key: (value) => value.id
        },
        async () => {}
    )
    const compatible = controlledSource("compatible", input)
    const incompatible = controlledSource("incompatible", z.string())

    // when the trigger signatures are inspected and an inferred mapper is supplied
    const handle = clankhouse.addTrigger(incompatible.source, workflow, {
        eventToInput: (event) => {
            expectTypeOf(event).toEqualTypeOf<string>()
            return { id: event, value: event.length }
        }
    })

    // then refs and handles retain their public types and mapping is required only when needed
    expectTypeOf(workflow).toEqualTypeOf<WorkflowRef<{ id: string; value: number }>>()
    expectTypeOf(handle).toEqualTypeOf<TriggerHandle>()
    expectTypeOf<TriggerArguments<{ id: string; value: number }, { id: string; value: number }>>().toEqualTypeOf<
        [options?: TriggerOptions<{ id: string; value: number }, { id: string; value: number }>]
    >()
    expectTypeOf<TriggerArguments<string, { id: string; value: number }>>().toEqualTypeOf<
        [
            options: TriggerOptions<string, { id: string; value: number }> & {
                eventToInput: (event: string) => { id: string; value: number }
            }
        ]
    >()
    const compatibleHandle = clankhouse.addTrigger(compatible.source, workflow)
    const exportedTriggers = new Triggers(clankhouse.workflows)
    const exportedCompatibleAdd = exportedTriggers.add<typeof input, { id: string; value: number }>
    const exportedIncompatibleAdd = exportedTriggers.add<z.ZodString, { id: string; value: number }>
    expectTypeOf(exportedCompatibleAdd).parameters.toEqualTypeOf<
        [
            source: EventSource<typeof input>,
            workflow: WorkflowRef<{ id: string; value: number }>,
            options?: TriggerOptions<{ id: string; value: number }, { id: string; value: number }>
        ]
    >()
    expectTypeOf(exportedIncompatibleAdd).parameters.toEqualTypeOf<
        [
            source: EventSource<z.ZodString>,
            workflow: WorkflowRef<{ id: string; value: number }>,
            options: TriggerOptions<string, { id: string; value: number }> & {
                eventToInput: (event: string) => { id: string; value: number }
            }
        ]
    >()
    compatibleHandle.stop()
    handle.stop()
})

test("onError receives trigger failures and leaves the trigger active unless stopped", async () => {
    // given a trigger whose source, schema, mapper, and workflow input can each fail
    const instanceErrors: unknown[] = []
    const clankhouse = configuredClankHouse((error) => {
        instanceErrors.push(error)
    })
    const workflow = clankhouse.registerWorkflow(
        "recovering-trigger",
        {
            input: z.object({ id: z.string(), value: z.number() }),
            output: z.number(),
            key: (value) => value.id
        },
        async (value) => value.value * 2
    )
    const source = controlledSource("recovering", z.number())
    const mappingError = new Error("mapping failed")
    const sourceError = new Error("source failed")
    const errors: unknown[] = []
    clankhouse.addTrigger(source.source, workflow, {
        eventToInput: (event) => {
            if (event === 2) throw mappingError
            if (event === 4) return { id: "invalid", value: "wrong" } as never
            return { id: String(event), value: event }
        },
        onError: (error) => {
            errors.push(error)
        }
    })

    // when failures occur and a later valid event arrives
    source.emit("invalid" as never)
    source.emit(2)
    source.fail(sourceError)
    source.emit(4)
    source.emit(3)

    // then each failure is reported without preventing the valid event from starting the workflow
    expect(errors[0]).toMatchObject({ code: "event_schema_validation_failed" })
    expect(errors[1]).toBe(mappingError)
    expect(errors[2]).toBe(sourceError)
    expect(errors[3]).toBeInstanceOf(z.ZodError)
    expect(instanceErrors).toEqual([])
    const run = (await clankhouse.runs.list({ workflowName: "recovering-trigger", key: "3" }))[0]
    expect(await runOutput(clankhouse, run.id)).toBe(6)
    expect(source.stops()).toBe(0)
})

test("an error handler can stop a trigger during synchronous source startup", async () => {
    // given a source that emits an invalid event synchronously while starting
    const { clankhouse } = tempClankHouse()
    const workflow = clankhouse.registerWorkflow(
        "synchronous-stop",
        { input: z.number(), output: z.number(), key: String },
        async (value) => value
    )
    let listener: EventSourceListener<number> | undefined
    let stops = 0
    let handled: unknown
    const activeSource = {
        key: "synchronous-stop",
        schema: z.number(),
        start(value: EventSourceListener<number>) {
            listener = value
            value.emit("invalid" as never)
            return { stop: () => stops++ }
        }
    }

    // when onError stops the wrapper handle before the source handle is returned
    const handle = clankhouse.addTrigger(activeSource, workflow, {
        onError: (error, trigger) => {
            handled = error
            trigger.stop()
        }
    })
    listener?.emit(2)
    handle.stop()

    // then the eventual source handle is stopped once and later emissions are ignored
    expect(handled).toMatchObject({ code: "event_schema_validation_failed" })
    expect(stops).toBe(1)
    expect(await clankhouse.runs.list({ workflowName: "synchronous-stop" })).toEqual([])
})

test("the instance error handler owns asynchronous trigger failures", async () => {
    // given a direct trigger with an instance-level error handler
    const errors: unknown[] = []
    const handled = gate()
    const clankhouse = configuredClankHouse(async (error) => {
        errors.push(error)
        handled.release()
    })
    const workflow = clankhouse.registerWorkflow(
        "asynchronous-error-trigger",
        { input: z.number(), output: z.number(), key: String },
        async (value) => value
    )
    const source = controlledSource("asynchronous-error", z.number())
    const handle = clankhouse.addTrigger(source.source, workflow)

    // when the source emits an invalid event asynchronously followed by a valid event
    queueMicrotask(() => source.emit("invalid" as never))
    await handled.released
    source.emit(5)

    // then the instance handler receives the error without disabling the trigger
    expect(errors).toEqual([expect.objectContaining({ code: "event_schema_validation_failed" })])
    const run = (await clankhouse.runs.list({ workflowName: "asynchronous-error-trigger", key: "5" }))[0]
    expect(await runOutput(clankhouse, run.id)).toBe(5)
    handle.stop()
})

test("handler failures fall back to the built-in reporter without escaping source callbacks", async () => {
    // given an instance handler that throws synchronously and then rejects asynchronously
    const synchronousError = new Error("synchronous handler failure")
    const asynchronousError = new Error("asynchronous handler failure")
    const reported: unknown[] = []
    const reportedTwice = gate()
    const reporter = vi.spyOn(console, "error").mockImplementation((_message, error) => {
        reported.push(error)
        if (reported.length === 2) reportedTwice.release()
    })
    onTestFinished(() => reporter.mockRestore())
    let calls = 0
    const clankhouse = configuredClankHouse(() => {
        calls++
        if (calls === 1) throw synchronousError
        return Promise.reject(asynchronousError)
    })
    const workflow = clankhouse.registerWorkflow(
        "handler-failure-trigger",
        { input: z.number(), output: z.void(), key: String },
        async () => {}
    )
    const source = controlledSource("handler-failure", z.number())
    const handle = clankhouse.addTrigger(source.source, workflow)

    // when two source failures reach the instance handler
    let escaped: unknown
    try {
        source.fail(new Error("first source failure"))
        source.fail(new Error("second source failure"))
    } catch (error) {
        escaped = error
    }
    await reportedTwice.released

    // then neither callback throws and both handler failures reach the safe fallback reporter
    expect(escaped).toBeUndefined()
    expect(reported).toEqual([synchronousError, asynchronousError])
    handle.stop()
})

test("addTrigger distinguishes foreign workflow references while validating before startup", () => {
    // given refs from separate instances plus passive and startup-failing sources
    const { clankhouse } = tempClankHouse()
    const { clankhouse: other } = tempClankHouse()
    const local = clankhouse.registerWorkflow(
        "shared-trigger",
        { input: z.number(), output: z.void(), key: String },
        async () => {}
    )
    const foreign = other.registerWorkflow(
        "foreign-trigger",
        { input: z.number(), output: z.void(), key: String },
        async () => {}
    )
    const active = controlledSource("active", z.number())
    const startupError = new Error("startup failed")

    // when a workflow name is missing or triggers target a foreign ref, passive source, or failing source
    const unregistered = () => clankhouse.workflows.get("missing-trigger")
    const wrongInstance = () => clankhouse.addTrigger(active.source, foreign)
    const passive = () => clankhouse.addTrigger({ key: "passive", schema: z.number() }, local)
    const startup = () =>
        clankhouse.addTrigger(
            {
                key: "startup",
                schema: z.number(),
                start: () => {
                    throw startupError
                }
            },
            local
        )

    // then validation fails immediately without leaving a source active
    expect(unregistered).toThrow(expect.objectContaining({ code: "workflow_not_registered" }))
    expect(wrongInstance).toThrow(expect.objectContaining({ code: "workflow_reference_foreign" }))
    expect(active.starts()).toBe(0)
    expect(passive).toThrow(expect.objectContaining({ code: "event_source_not_startable" }))
    expect(startup).toThrow(startupError)
    // and the local reference remains valid
    const handle = clankhouse.addTrigger(active.source, local)
    expect(active.starts()).toBe(1)
    handle.stop()
})

test("manual events bypass triggers and a closed instance rejects new trigger sources", async () => {
    // given an active trigger and no workflow runs
    const { clankhouse } = tempClankHouse()
    const workflow = clankhouse.registerWorkflow(
        "isolated-trigger",
        { input: z.number(), output: z.void(), key: String },
        async () => {}
    )
    const source = controlledSource("isolated", z.number())
    const lateSource = controlledSource("late", z.number())
    const handle = clankhouse.addTrigger(source.source, workflow)

    // when an event is persisted manually and the instance is then closed
    await clankhouse.emit(source.source.key, 1)
    expect(await clankhouse.runs.list({ workflowName: "isolated-trigger" })).toEqual([])
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 })
    clankhouse.close()
    clankhouse.close()
    source.emit(2)
    handle.stop()
    const afterClose = () => clankhouse.addTrigger(lateSource.source, workflow)

    // then the manual event never reaches the trigger and its source is stopped exactly once
    expect(source.stops()).toBe(1)
    // and a later trigger is rejected before its source starts
    expect(afterClose).toThrow(expect.objectContaining({ code: "clankhouse_closed" }))
    expect(lateSource.starts()).toBe(0)
})

test("synchronous triggers with the same source key remain independent", async () => {
    // given two sources sharing a key and emitting synchronously during registration
    const { clankhouse } = tempClankHouse()
    const workflow = clankhouse.registerWorkflow(
        "shared-key-trigger",
        {
            input: z.object({ id: z.string(), value: z.number() }),
            output: z.number(),
            key: (value) => value.id
        },
        async (value) => value.value
    )
    const source = (id: string, value: number) => ({
        key: "shared",
        schema: z.object({ id: z.string(), value: z.number() }),
        start(listener: EventSourceListener<{ id: string; value: number }>) {
            listener.emit({ id, value })
            return { stop() {} }
        }
    })

    // when both triggers are added
    clankhouse.addTrigger(source("first", 1), workflow)
    clankhouse.addTrigger(source("second", 2), workflow)

    // then both synchronous events start their own workflow runs
    const first = (await clankhouse.runs.list({ workflowName: "shared-key-trigger", key: "first" }))[0]
    const second = (await clankhouse.runs.list({ workflowName: "shared-key-trigger", key: "second" }))[0]
    expect(await runOutput(clankhouse, first.id)).toBe(1)
    expect(await runOutput(clankhouse, second.id)).toBe(2)
})
