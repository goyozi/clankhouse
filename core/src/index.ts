import * as z from "zod"
import { ClankHouse } from "./clankhouse.js"
import type { EventSource, EventSourceResult } from "./events.js"
import type { TriggerArguments, TriggerHandle } from "./triggers.js"
import type { RerunOptions, WorkflowOptions, WorkflowRef, Workflows } from "./workflows.js"
import type { WorkflowRuns } from "./runs.js"
import type { Artifacts } from "./artifacts.js"
import type { AISessions } from "./ai/sessions.js"

let instance: ClankHouse | undefined

export function clankhouse(): ClankHouse {
    if (instance === undefined || instance.closed) instance = new ClankHouse()
    return instance
}

export function workflows(): Workflows {
    return clankhouse().workflows
}

export function runs(): WorkflowRuns {
    return clankhouse().runs
}

export function artifacts(): Artifacts {
    return clankhouse().artifacts
}

export function sessions(): AISessions {
    return clankhouse().sessions
}

export function registerWorkflow<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    name: string,
    options: WorkflowOptions<I, O>,
    workflowFn: (input: z.infer<I>) => Promise<z.infer<O>>
): WorkflowRef<z.input<I>> {
    return clankhouse().registerWorkflow(name, options, workflowFn)
}

export function addTrigger<S extends z.ZodTypeAny, Input>(
    source: EventSource<S>,
    workflow: WorkflowRef<Input>,
    ...options: TriggerArguments<z.output<S>, Input>
): TriggerHandle {
    return clankhouse().addTrigger(source, workflow, ...options)
}

export function start(name: string, input?: any): string {
    return clankhouse().start(name, input)
}

export function resume(runId: string): string {
    return clankhouse().resume(runId)
}

export function rerun(runId: string, options: RerunOptions): string {
    return clankhouse().rerun(runId, options)
}

export function run<T extends z.ZodTypeAny>(
    name: string,
    key: string,
    output: T,
    workflowFn: () => Promise<z.infer<T>>
): Promise<z.infer<T>> {
    return clankhouse().run(name, key, output, workflowFn)
}

export function step<T extends z.ZodTypeAny>(
    name: string,
    output: T,
    stepFn: () => Promise<z.infer<T>>
): Promise<z.infer<T>> {
    return clankhouse().step(name, output, stepFn)
}

export function prefix<O>(name: string, fn: () => Promise<O>): Promise<O> {
    return clankhouse().prefix(name, fn)
}

export function emit(key: string, event: any): Promise<void> {
    return clankhouse().emit(key, event)
}

export function waitFor<T extends z.ZodTypeAny>(source: EventSource<T>): Promise<z.output<T>> {
    return clankhouse().waitFor(source)
}

export function waitForAny<const S extends readonly EventSource[]>(sources: S): Promise<EventSourceResult<S[number]>> {
    return clankhouse().waitForAny(sources)
}

export type { RerunOptions, WorkflowOptions, WorkflowRef } from "./workflows.js"
export type { EventSource, EventSourceHandle, EventSourceListener, EventSourceResult } from "./events.js"
export type { TriggerErrorHandler, TriggerHandle, TriggerOptions } from "./triggers.js"
export type { ClankHouseOptions } from "./clankhouse.js"
export { fileCreated, fileCreatedIn } from "./files.js"
export { ClankHouseError } from "./errors.js"
export type { ClankHouseErrorCode } from "./errors.js"
