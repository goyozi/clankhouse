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
import { moveFile } from "./files.js"
import { Notifier } from "./watch.js"
import { Triggers, type TriggerArguments, type TriggerErrorHandler, type TriggerHandle } from "./triggers.js"
import {
    Workflows,
    type RecoverResult,
    type RerunOptions,
    type StartResult,
    type WorkflowOptions,
    type WorkflowRef
} from "./workflows.js"
import { gcWorktrees, type WorktreeGcResult } from "./git/index.js"
import { gcRuns, type RunGcResult } from "./gc.js"

export type GcOptions = {
    /**
     * Minimum age (in whole days, at least 1) of collected runs, worktrees and restore refs. Defaults to 14.
     */
    minAgeDays?: number
    /**
     * Whether finished runs older than `minAgeDays` are soft deleted. Defaults to true.
     */
    deleteRuns?: boolean
}

export type GcResult = { runs: RunGcResult; worktrees: WorktreeGcResult }

const DAY_MS = 24 * 60 * 60 * 1000

export function validateGcOptions(options: GcOptions): number {
    const minAgeDays = options.minAgeDays ?? 14
    if (!Number.isInteger(minAgeDays) || minAgeDays < 1) {
        throw new RangeError(`minAgeDays must be an integer of at least 1, received ${minAgeDays}`)
    }
    return minAgeDays
}

export type StepContext = {
    signal: AbortSignal
}

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
    private readonly active: ActiveSets
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
        this.active = active
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
     * Idempotently creates a workflow run for a registered workflow and returns its ID and observable status.
     * If no run exists for the input's key, a new run is created and dispatched.
     * If a run already exists for the key, in any status, this is a no-op that returns the existing run.
     * Existing interrupted runs are not resumed; use `resume()` or `recover()` for that.
     */
    start(name: string, input?: any): StartResult {
        return this.workflows.start(name, input)
    }

    resume(runId: string): string {
        return this.workflows.resume(runId)
    }

    rerun(runId: string, options: RerunOptions): string {
        return this.workflows.rerun(runId, options)
    }

    cancel(runId: string): void {
        this.workflows.cancel(runId)
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

    recover(): RecoverResult {
        return this.workflows.recover()
    }

    /**
     * Wraps custom function as a durable step.
     * On re-run, stored output is validated against provided output schema.
     */
    step<T extends z.ZodTypeAny>(
        name: string,
        output: T,
        stepFn: (context: StepContext) => Promise<z.infer<T>>
    ): Promise<z.infer<T>> {
        return this.engine.executeStep({
            kind: "custom",
            name,
            schema: output,
            execute: (handle) => stepFn({ signal: handle.signal })
        })
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
     * Moves a file as a durable step, creating missing parent directories of the target.
     * Fails if the target already exists, unless the source is gone (i.e. the move already happened).
     */
    moveFile(name: string, from: string, to: string): Promise<void> {
        return this.step(name, z.void(), () => moveFile(from, to))
    }

    /**
     * Soft deletes succeeded, failed and canceled runs that ended more than `minAgeDays` ago and are not running,
     * then cleans up dangling (unassigned) worktrees older than `minAgeDays`.
     * Deleted runs keep a tombstone: they are hidden from listings, their key stays a no-op for `start()`
     * and `run()` throws `workflow_run_deleted`. Artifact references inside run or step inputs/outputs may dangle.
     * Limitations:
     * - Does not (yet) clean up user/agent snapshot refs.
     * - Concurrent GC invocations are not supported.
     * - Unexpected Git metadata inconsistencies require manual repair.
     */
    async gc(options: GcOptions = {}): Promise<GcResult> {
        const minAgeDays = validateGcOptions(options)
        const minAgeMs = minAgeDays * DAY_MS
        const runs =
            (options.deleteRuns ?? true)
                ? await gcRuns(this.clankhouseDir, this.db, this.active, new Date(Date.now() - minAgeMs))
                : { deleted: 0 }
        const worktrees = await gcWorktrees(this.clankhouseDir, this.db, minAgeMs)
        return { runs, worktrees }
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
