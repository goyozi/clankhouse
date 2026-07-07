import * as z from "zod";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveLoopyDir } from "./util";
import { WorkflowRuns } from "./runs";
import { Artifacts } from "./artifacts";
import { AISessions } from "./ai/sessions";
import { openDatabase } from "./db";
import type { ActiveSets } from "./runtime";
import { Engine } from "./engine";
import { Events } from "./events";
import { runContext } from "./context";
import { decode } from "./codec";

type RegisteredWorkflow = {
    options: { input: z.ZodTypeAny, output: z.ZodTypeAny, key: (input: any) => string },
    fn: (input: any) => Promise<any>
}

export class Loopy {
    readonly loopyDir: string
    readonly runs: WorkflowRuns
    readonly artifacts: Artifacts
    readonly sessions: AISessions
    readonly db: DatabaseSync
    readonly active: ActiveSets = { runs: new Map(), steps: new Set(), sessions: new Set() }
    readonly engine: Engine
    readonly events: Events
    private readonly workflows = new Map<string, RegisteredWorkflow>()

    /**
     * @param loopyDir path in which all Loopy-managed files are stored. Defaults to $LOOPY_DIR, if present, or ~/.loopy otherwise
     */
    constructor(loopyDir?: string) {
        this.loopyDir = resolveLoopyDir(loopyDir)
        mkdirSync(this.loopyDir, { recursive: true })
        this.db = openDatabase(path.join(this.loopyDir, "loopy.db"))
        this.engine = new Engine(this.db, this.active, this.loopyDir)
        this.events = new Events(this.db)
        this.runs = new WorkflowRuns(this.db, this.active)
        this.artifacts = new Artifacts(this.loopyDir, this.db, this.engine)
        this.sessions = new AISessions(this.db, this.active)
    }

    close(): void {
        this.db.close()
    }

    registerWorkflow<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(name: string, options: WorkflowOptions<I, O>, workflowFn: (input: z.infer<I>) => Promise<z.infer<O>>) {
        if (this.workflows.has(name)) throw new Error(`Workflow "${name}" is already registered`)
        this.workflows.set(name, { options, fn: workflowFn })
    }

    /**
     * Starts a workflow run for a registered workflow. Promise resolves when run is **started**.
     *
     * Rerun semantics:
     * - Not provided & no existing run -> attempt #1
     * - Not provided & existing run interrupted -> resume
     * - Not provided & existing run running or succeeded -> no-op
     * - Not provided & existing run failed -> error, no chance of success
     * - Provided & existing run running or interrupted -> error, no concurrent attempts allowed
     * - Provided & existing run NOT running nor interrupted -> new attempt from given step, reuse / restore results from previous steps
     *
     * @see Loopy.registerWorkflow
     */
    async start(name: string, input: any, rerun?: RerunOptions): Promise<void> {
        const registered = this.workflows.get(name)
        if (!registered) throw new Error(`Workflow "${name}" is not registered`)
        const parsed = registered.options.input.parse(input)
        const key = registered.options.key(parsed)
        const plan = this.engine.resolvePlan(name, key, parsed, rerun)
        if (plan.type !== "execute") return
        this.engine.executeRun(this, plan.runRow, async () => registered.options.output.parse(await registered.fn(parsed))).catch(() => { })
    }

    /**
     * Starts a workflow run and awaits its completion. Promise resolves when run is **finished**.
     *
     * @see Loopy.start for re-run semantics
     */
    async run<O>(name: string, key: string, workflowFn: () => Promise<O>, rerun?: RerunOptions): Promise<O> {
        const plan = this.engine.resolvePlan(name, key, undefined, rerun)
        switch (plan.type) {
            case "noopRunning": return this.active.runs.get(plan.runId)!.promise as Promise<O>
            case "noopSucceeded": return plan.runRow.output === null ? undefined as O : decode(plan.runRow.output)
            case "execute": return this.engine.executeRun(this, plan.runRow, workflowFn)
        }
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
        const ctx = runContext.getStore()
        if (!ctx) return this.events.emit(key, event)
        await this.engine.executeStep({
            kind: "event",
            name: `emit:${key}`,
            schema: z.void(),
            execute: async (handle) => {
                await this.events.emit(key, event, `${ctx.workflowName}/${ctx.runKey}/${handle.stepKey}`)
                handle.set("event_key", key)
            }
        })
    }

    /**
     * Waits for a single, specific event on a given key.
     * Arriving events are validated against expected schema.
     * In case of schema validation errors, the promise is rejected.
     */
    async waitFor<T extends z.ZodTypeAny>(key: string, schema: T): Promise<z.infer<T>> {
        const result = await this.waitForEventStep([{ key, schema }], `wait:${key}`)
        return result.event
    }

    /**
     * Waits for first event matching provided definitions (key + schema).
     * Provided definitions list must not be empty.
     * Arriving events are validated against expected schema.
     * In case of schema validation errors, the promise is rejected.
     * Resolves to { key, event } so callers know which definition matched.
     */
    async waitForAny(defs: EventDefinition<any>[]): Promise<any> {
        if (defs.length === 0) throw new Error("waitForAny requires at least one event definition")
        return this.waitForEventStep(defs, `wait:${defs.map(d => d.key).join("+")}`)
    }

    private waitForEventStep(defs: EventDefinition<any>[], stepName: string): Promise<{ key: string, event: any }> {
        const variants = defs.map(d => z.object({ key: z.literal(d.key), event: d.schema }))
        const schema = variants.length === 1 ? variants[0] : z.union(variants)
        return this.engine.executeStep({
            kind: "event",
            name: stepName,
            schema,
            execute: async (handle) => {
                const result = await this.events.waitForEvent(defs, handle.stepId)
                handle.set("event_key", result.key)
                return result
            }
        })
    }
}

export type WorkflowOptions<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
    input: I,
    output: O,
    key: (input: z.infer<I>) => string
}

export type RerunOptions = { from: string }

export type EventDefinition<T extends z.ZodTypeAny> = { key: string, schema: T }
