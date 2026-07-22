import * as z from "zod"
import { mkdirSync } from "node:fs"
import * as path from "node:path"
import { openDatabase, type Db } from "./db"
import { resolveLoopyDir } from "./util"
import { WorkflowRuns } from "./runs"
import { Artifacts } from "./artifacts"
import { AISessions } from "./ai/sessions"
import type { ActiveSets } from "./runtime"
import { Engine } from "./engine"
import { Events, type EventDefinition } from "./events"
import { Notifier } from "./watch"
import { Workflows, type RerunOptions, type WorkflowOptions } from "./workflows"

export class Loopy {
    readonly loopyDir: string
    readonly runs: WorkflowRuns
    readonly artifacts: Artifacts
    readonly sessions: AISessions
    readonly workflows: Workflows
    readonly db: Db
    readonly engine: Engine
    readonly events: Events

    /**
     * @param loopyDir path in which all Loopy-managed files are stored. Defaults to $LOOPY_DIR, if present, or ~/.loopy otherwise
     */
    constructor(loopyDir?: string) {
        this.loopyDir = resolveLoopyDir(loopyDir)
        mkdirSync(this.loopyDir, { recursive: true, mode: 0o700 })
        this.db = openDatabase(path.join(this.loopyDir, "loopy.db"))
        const notifier = new Notifier()
        const active: ActiveSets = { runs: new Map(), steps: new Set(), sessions: new Set() }
        this.engine = new Engine(this.db, active, notifier)
        this.artifacts = new Artifacts(this.loopyDir, this.db, this.engine)
        this.workflows = new Workflows(this, this.db, this.engine, active, this.artifacts)
        this.events = new Events(this.db, this.engine)
        this.runs = new WorkflowRuns(this.db, active, notifier)
        this.sessions = new AISessions(this.db, active)
    }

    close(): void {
        this.db.close()
    }

    registerWorkflow<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
        name: string,
        options: WorkflowOptions<I, O>,
        workflowFn: (input: z.infer<I>) => Promise<z.infer<O>>
    ): void {
        this.workflows.register(name, options, workflowFn)
    }

    /**
     * Starts a workflow run for a registered workflow and returns its ID after dispatching it.
     * Existing interrupted runs resume with their persisted input. Running and succeeded runs are no-ops.
     */
    start(name: string, input: any): string {
        return this.workflows.start(name, input)
    }

    resume(runId: string): string {
        return this.workflows.resume(runId)
    }

    rerun(runId: string, options: RerunOptions): string {
        return this.workflows.rerun(runId, options)
    }

    /**
     * Starts a workflow run and awaits its completion. Promise resolves when run is **finished**.
     */
    run<T extends z.ZodTypeAny>(
        name: string,
        key: string,
        output: T,
        workflowFn: () => Promise<z.infer<T>>
    ): Promise<z.infer<T>> {
        return this.workflows.run(name, key, output, workflowFn)
    }

    /**
     * Wraps custom function as a durable step.
     * On re-run, stored output is validated against provided output schema.
     */
    step<T extends z.ZodTypeAny>(name: string, output: T, stepFn: () => Promise<z.infer<T>>): Promise<z.infer<T>> {
        return this.engine.executeStep({ kind: "custom", name, schema: output, execute: stepFn })
    }

    /**
     * Prefixes all nested durable steps with provided value.
     * Prefix call is not a step and is not durable.
     */
    prefix<O>(prefix: string, fn: () => Promise<O>): Promise<O> {
        return this.engine.prefix(prefix, fn)
    }

    /**
     * Emits provided event resolving or rejecting all waits for a given key.
     * Inside a workflow run, the emit is a durable step and is not repeated on replay.
     *
     * @see Loopy.waitFor
     * @see Loopy.waitForAny
     */
    async emit(key: string, event: any): Promise<void> {
        return this.events.emit(key, event)
    }

    /**
     * Waits for a single, specific event on a given key.
     * Arriving events are validated against expected schema.
     * In case of schema validation errors, the promise is rejected.
     */
    async waitFor<T extends z.ZodTypeAny>(key: string, schema: T): Promise<z.infer<T>> {
        return this.events.waitFor(key, schema)
    }

    /**
     * Waits for first event matching provided definitions (key + schema).
     * Provided definitions list must not be empty.
     * Arriving events are validated against expected schema.
     * In case of schema validation errors, the promise is rejected.
     * Resolves to { key, event } so callers know which definition matched.
     */
    async waitForAny(defs: EventDefinition<any>[]): Promise<any> {
        return this.events.waitForAny(defs)
    }
}

export type { EventDefinition } from "./events"
