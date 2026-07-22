import * as z from "zod"
import { Loopy } from "./loopy"
import type { EventDefinition } from "./events"
import type { RerunOptions, WorkflowOptions, Workflows } from "./workflows"
import type { WorkflowRuns } from "./runs"
import type { Artifacts } from "./artifacts"
import type { AISessions } from "./ai/sessions"

let instance: Loopy | undefined

export function loopy(): Loopy {
    return (instance ??= new Loopy())
}

export function workflows(): Workflows {
    return loopy().workflows
}

export function runs(): WorkflowRuns {
    return loopy().runs
}

export function artifacts(): Artifacts {
    return loopy().artifacts
}

export function sessions(): AISessions {
    return loopy().sessions
}

export function registerWorkflow<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    name: string,
    options: WorkflowOptions<I, O>,
    workflowFn: (input: z.infer<I>) => Promise<z.infer<O>>
) {
    loopy().registerWorkflow(name, options, workflowFn)
}

export function start(name: string, input: any): string {
    return loopy().start(name, input)
}

export function resume(runId: string): string {
    return loopy().resume(runId)
}

export function rerun(runId: string, options: RerunOptions): string {
    return loopy().rerun(runId, options)
}

export function run<T extends z.ZodTypeAny>(
    name: string,
    key: string,
    output: T,
    workflowFn: () => Promise<z.infer<T>>
): Promise<z.infer<T>> {
    return loopy().run(name, key, output, workflowFn)
}

export function step<T extends z.ZodTypeAny>(
    name: string,
    output: T,
    stepFn: () => Promise<z.infer<T>>
): Promise<z.infer<T>> {
    return loopy().step(name, output, stepFn)
}

export function prefix<O>(name: string, fn: () => Promise<O>): Promise<O> {
    return loopy().prefix(name, fn)
}

export function emit(key: string, event: any): Promise<void> {
    return loopy().emit(key, event)
}

export function waitFor<T extends z.ZodTypeAny>(key: string, schema: T): Promise<z.infer<T>> {
    return loopy().waitFor(key, schema)
}

export function waitForAny(defs: EventDefinition<any>[]): Promise<any> {
    return loopy().waitForAny(defs)
}

export type { RerunOptions, WorkflowOptions } from "./workflows"
export { LoopyError } from "./errors"
export type { LoopyErrorCode } from "./errors"
