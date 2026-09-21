import * as z from "zod"
import { mkdirSync } from "node:fs"
import * as path from "node:path"
import { openDatabase, type Db } from "./db.js"
import { resolveClankHouseDir } from "./util.js"
import { WorkflowRuns } from "./runs.js"
import { Artifacts } from "./artifacts.js"
import { AISessions } from "./ai/sessions.js"
import type { ActiveSets } from "./runtime.js"
import { Engine } from "./engine.js"
import { Events, type ActiveEventSource, type EventSource, type EventSourceResult } from "./events.js"
import { ClankHouseError } from "./errors.js"
import { Notifier } from "./watch.js"
import { Triggers, type TriggerArguments, type TriggerErrorHandler, type TriggerHandle } from "./triggers.js"
import { Workflows, type RerunOptions, type WorkflowOptions, type WorkflowRef } from "./workflows.js"
import { gcWorktrees, type WorktreeGcResult } from "./git/index.js"

export type ClankHouseOptions = {
    onTriggerError?: TriggerErrorHandler
}

export class ClankHouse {
    readonly clankhouseDir: string
    readonly runs: WorkflowRuns
    readonly artifacts: Artifacts
    readonly sessions: AISessions
    readonly workflows: Workflows
    readonly db: Db
    readonly engine: Engine
    readonly events: Events
    private readonly triggers: Triggers
    private isClosed = false

    /**
     * @param clankhouseDir path in which all ClankHouse-managed files are stored. Defaults to $CLANKHOUSE_DIR, if present, or ~/.clankhouse otherwise
     * Note: ClankHouse assumes full ownership of provided path and may delete files inside.
     *
     * @see gc
     */
    constructor(clankhouseDir?: string, options: ClankHouseOptions = {}) {
        this.clankhouseDir = resolveClankHouseDir(clankhouseDir)
        mkdirSync(this.clankhouseDir, { recursive: true, mode: 0o700 })
        this.db = openDatabase(path.join(this.clankhouseDir, "clankhouse.db"))
        const notifier = new Notifier()
        const active: ActiveSets = { runs: new Map(), steps: new Set(), sessions: new Set() }
        this.engine = new Engine(this.db, active, notifier)
        this.artifacts = new Artifacts(this.clankhouseDir, this.db, this.engine)
        this.workflows = new Workflows(this, this.db, this.engine, active, this.artifacts)
        this.triggers = new Triggers(this.workflows, options.onTriggerError)
        this.events = new Events(this.db, this.engine)
        this.runs = new WorkflowRuns(this.db, active, notifier)
        this.sessions = new AISessions(this.db, active)
    }

    get closed(): boolean {
        return this.isClosed
    }

    close(): void {
        if (this.isClosed) return
        this.isClosed = true
        this.triggers.close()
        this.events.close()
        this.db.close()
    }

    registerWorkflow<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
        name: string,
        options: WorkflowOptions<I, O>,
        workflowFn: (input: z.infer<I>) => Promise<z.infer<O>>
    ): WorkflowRef<z.input<I>> {
        return this.workflows.register(name, options, workflowFn)
    }

    addTrigger<S extends z.ZodTypeAny, Input>(
        source: ActiveEventSource<S>,
        workflow: WorkflowRef<Input>,
        ...options: TriggerArguments<z.output<S>, Input>
    ): TriggerHandle {
        if (this.isClosed) {
            throw new ClankHouseError("clankhouse_closed", "Cannot add a trigger to a closed ClankHouse instance")
        }
        return this.triggers.add(source, workflow, ...options)
    }

    /**
     * Starts a workflow run for a registered workflow and returns its ID after dispatching it.
     * Existing interrupted runs resume with their persisted input. Running and succeeded runs are no-ops.
     */
    start(name: string, input?: any): string {
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
     * Inside a workflow run, emit is a durable step and is not repeated on replay.
     *
     * @see ClankHouse.waitFor
     * @see ClankHouse.waitForAny
     */
    async emit(key: string, event: any): Promise<void> {
        return this.events.emit(key, event)
    }

    /**
     * Waits for a single event from the provided source.
     * Arriving events are validated against expected schema.
     * In case of schema validation errors, the promise is rejected.
     */
    async waitFor<T extends z.ZodTypeAny>(source: EventSource<T>): Promise<z.output<T>> {
        return this.events.waitFor(source)
    }

    /**
     * Waits for the first event from the provided sources.
     * Provided source list must not be empty.
     * Arriving events are validated against expected schema.
     * In case of schema validation errors, the promise is rejected.
     * Resolves to { key, event } so callers know which source matched.
     */
    async waitForAny<const S extends readonly EventSource[]>(sources: S): Promise<EventSourceResult<S[number]>> {
        return this.events.waitForAny(sources)
    }

    /**
     * Cleans up dangling (unassigned) worktrees older than 14 days.
     * Limitations:
     * - Does not (yet) clean up old runs and user/agent snapshot refs.
     * - Concurrent GC invocations are not supported.
     * - Unexpected Git metadata inconsistencies require manual repair.
     */
    async gc(): Promise<{ worktrees: WorktreeGcResult }> {
        return { worktrees: await gcWorktrees(this.clankhouseDir, this.db) }
    }
}

export type {
    ActiveEventSource,
    ApiEventSource,
    EventSource,
    EventSourceHandle,
    EventSourceListener,
    EventSourceResult
} from "./events.js"
export type { TriggerErrorHandler, TriggerHandle, TriggerOptions } from "./triggers.js"
export type { WorkflowRef } from "./workflows.js"
