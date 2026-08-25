import * as z from "zod"
import { ClankHouseError } from "./errors.js"
import type { EventSource, EventSourceHandle, EventSourceListener } from "./events.js"
import type { WorkflowRef, Workflows } from "./workflows.js"

export type TriggerHandle = {
    stop(): void
}

export type TriggerErrorHandler = (error: unknown, handle: TriggerHandle) => void | Promise<void>

export type TriggerOptions<Event, Input> = {
    eventToInput?: (event: Event) => Input
    onError?: TriggerErrorHandler
}

export type TriggerArguments<Event, Input> = [Event] extends [Input]
    ? [options?: TriggerOptions<Event, Input>]
    : [options: TriggerOptions<Event, Input> & { eventToInput: (event: Event) => Input }]

type ActiveTrigger = {
    active: boolean
    handle: TriggerHandle
    sourceHandle?: EventSourceHandle
}

type StartableEventSource<S extends z.ZodTypeAny> = EventSource<S> & {
    start(listener: EventSourceListener<z.input<S>>): EventSourceHandle
}

export class Triggers {
    private readonly workflows: Workflows
    private readonly onError: TriggerErrorHandler
    private readonly active = new Set<ActiveTrigger>()

    constructor(workflows: Workflows, onError: TriggerErrorHandler = reportTriggerError) {
        this.workflows = workflows
        this.onError = onError
    }

    add<S extends z.ZodTypeAny, Input>(
        source: EventSource<S>,
        workflow: WorkflowRef<Input>,
        ...[options]: TriggerArguments<z.output<S>, Input>
    ): TriggerHandle {
        this.workflows.get(workflow)
        this.requireStartable(source)
        const triggerOptions = options as TriggerOptions<z.output<S>, Input> | undefined
        const trigger = this.activate()

        try {
            this.start(trigger, source, workflow, triggerOptions)
            return trigger.handle
        } catch (error) {
            this.stop(trigger)
            throw error
        }
    }

    close(): void {
        for (const trigger of [...this.active]) this.stop(trigger)
    }

    private requireStartable<S extends z.ZodTypeAny>(
        source: EventSource<S>
    ): asserts source is StartableEventSource<S> {
        if (source.start) return
        throw new ClankHouseError(
            "event_source_not_startable",
            `Event source "${source.key}" cannot be used as a trigger because it has no start function`
        )
    }

    private activate(): ActiveTrigger {
        const trigger: ActiveTrigger = {
            active: true,
            handle: { stop: () => this.stop(trigger) }
        }
        this.active.add(trigger)
        return trigger
    }

    private start<S extends z.ZodTypeAny, Input>(
        trigger: ActiveTrigger,
        source: StartableEventSource<S>,
        workflow: WorkflowRef<Input>,
        options?: TriggerOptions<z.output<S>, Input>
    ): void {
        const sourceHandle = source.start({
            emit: (event) => this.emit(trigger, source, workflow, options, event),
            fail: (error) => this.handleError(trigger, error, options?.onError)
        })
        trigger.sourceHandle = sourceHandle
        if (!trigger.active) this.stopSource(sourceHandle)
    }

    private emit<S extends z.ZodTypeAny, Input>(
        trigger: ActiveTrigger,
        source: EventSource<S>,
        workflow: WorkflowRef<Input>,
        options: TriggerOptions<z.output<S>, Input> | undefined,
        event: z.input<S>
    ): void {
        if (!trigger.active) return
        try {
            const parsed = this.parseEvent(source, event)
            const input = options?.eventToInput ? options.eventToInput(parsed) : (parsed as Input)
            this.workflows.start(workflow, input)
        } catch (error) {
            this.handleError(trigger, error, options?.onError)
        }
    }

    private parseEvent<S extends z.ZodTypeAny>(source: EventSource<S>, event: z.input<S>): z.output<S> {
        try {
            return source.schema.parse(event)
        } catch (error) {
            throw this.eventError(source.key, error)
        }
    }

    private handleError(trigger: ActiveTrigger, error: unknown, onError?: TriggerErrorHandler): void {
        if (!trigger.active) return
        try {
            void Promise.resolve((onError ?? this.onError)(error, trigger.handle)).catch(reportTriggerError)
        } catch (handlerError) {
            reportTriggerError(handlerError)
        }
    }

    private eventError(key: string, error: unknown): unknown {
        if (!(error instanceof z.ZodError)) return error
        return new ClankHouseError(
            "event_schema_validation_failed",
            `Event on "${key}" failed schema validation: ${error.message}`,
            { cause: error }
        )
    }

    private stop(trigger: ActiveTrigger): void {
        if (!trigger.active) return
        trigger.active = false
        this.active.delete(trigger)
        if (trigger.sourceHandle) this.stopSource(trigger.sourceHandle)
    }

    private stopSource(handle: EventSourceHandle): void {
        try {
            handle.stop()
        } catch {}
    }
}

function reportTriggerError(error: unknown): void {
    try {
        console.error("ClankHouse trigger error", error)
    } catch {}
}
