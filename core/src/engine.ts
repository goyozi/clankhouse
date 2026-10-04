import * as z from "zod"
import type { ClankHouse } from "./clankhouse.js"
import { requireContext, runContext, type RunContext } from "./context.js"
import * as sql from "./db.js"
import type { Db, RunRow, StepColumn, StepKind, StepRow } from "./db.js"
import type { ActiveSets } from "./runtime.js"
import type { Notifier } from "./watch.js"
import { ClankHouseError } from "./errors.js"
import { errorMessage, newId, nowIso } from "./util.js"
import { jsonSchema, type SchemaIo } from "./json-schema.js"

export type { StepColumn } from "./db.js"

export type StepHandle = {
    readonly stepId: string
    readonly stepKey: string
    readonly signal: AbortSignal
    set(column: StepColumn, value: string | number): void
}

export type ExecuteStepOptions<T extends z.ZodTypeAny> = {
    kind: StepKind
    name: string
    schema: T
    schemaIo?: SchemaIo
    schemaRole?: string
    allowTopLevelVoid?: boolean
    execute: (handle: StepHandle) => Promise<unknown>
    parse?: (value: unknown) => z.infer<T>
    onSuccess?: (handle: StepHandle, output: z.infer<T>) => Promise<void>
    onError?: (handle: StepHandle) => Promise<void>
    onInterrupt?: (handle: StepHandle) => Promise<void>
    onReplay?: (row: StepRow) => Promise<void>
}

export class Engine {
    private readonly db: Db
    private readonly active: ActiveSets
    private readonly notifier: Notifier

    constructor(db: Db, active: ActiveSets, notifier: Notifier) {
        this.db = db
        this.active = active
        this.notifier = notifier
    }

    executeRun<T extends z.ZodTypeAny>(
        clankhouse: ClankHouse,
        runRow: RunRow,
        output: T,
        fn: () => Promise<z.infer<T>>
    ): Promise<z.infer<T>> {
        jsonSchema({
            schema: output,
            io: "output",
            role: `Workflow "${runRow.workflow_name}" output schema`,
            allowTopLevelVoid: true
        })
        const db = this.db
        const maxSeq = sql.findMaxStepSeq(db, runRow.id)
        const ctx: RunContext = {
            clankhouse,
            runId: runRow.id,
            runKey: runRow.key,
            workflowName: runRow.workflow_name,
            attempt: runRow.attempt,
            prefixes: [],
            seenStepKeys: new Set(),
            seq: { next: maxSeq + 1 },
            controller: new AbortController()
        }
        const signal = ctx.controller.signal
        const promise = Promise.resolve()
            .then(() => runContext.run(ctx, fn))
            .then((value) => output.parse(value))
            .then(
                (value) => {
                    signal.throwIfAborted()
                    sql.succeedRun(db, runRow.id, value === undefined ? null : JSON.stringify(value), nowIso())
                    return value
                },
                (e) => {
                    signal.throwIfAborted()
                    sql.failRun(db, runRow.id, errorMessage(e), errorCode(e), nowIso())
                    throw e
                }
            )
            .finally(() => {
                this.active.runs.delete(runRow.id)
                this.notifier.notify(runRow.id)
            })
        this.active.runs.set(runRow.id, { promise, controller: ctx.controller })
        return promise
    }

    async executeStep<T extends z.ZodTypeAny>(options: ExecuteStepOptions<T>): Promise<z.infer<T>> {
        const ctx = requireContext()
        ctx.controller.signal.throwIfAborted()
        const io = validateStepSchema(options)
        const key = this.claimStepKey(ctx, options.name)
        const existing = sql.findStep(this.db, ctx.runId, key)
        if (existing?.status === "succeeded") return this.replayStep(options, existing)
        const prepared = this.prepareStep(ctx, key, options, existing)
        return this.runPreparedStep(options, io, prepared)
    }

    private claimStepKey(ctx: RunContext, name: string): string {
        const key = [...ctx.prefixes, name].join("/")
        if (ctx.seenStepKeys.has(key)) {
            throw new ClankHouseError("workflow_step_duplicate", `Duplicate step "${key}" in run "${ctx.runKey}"`)
        }
        ctx.seenStepKeys.add(key)
        return key
    }

    private async replayStep<T extends z.ZodTypeAny>(
        options: ExecuteStepOptions<T>,
        row: StepRow
    ): Promise<z.infer<T>> {
        const stored = row.output === null ? undefined : JSON.parse(row.output)
        const output = parseStepOutput(options, stored)
        if (options.onReplay) await options.onReplay(row)
        return output
    }

    private prepareStep<T extends z.ZodTypeAny>(
        ctx: RunContext,
        key: string,
        options: ExecuteStepOptions<T>,
        existing: StepRow | undefined
    ): PreparedStep {
        const id = existing ? this.resetStep(existing) : this.insertStep(ctx, key, options)
        return { id, runId: ctx.runId, handle: this.stepHandle(id, ctx.runId, key, ctx.controller.signal) }
    }

    private resetStep(row: StepRow): string {
        sql.resetStep(this.db, row.id, nowIso())
        return row.id
    }

    private insertStep<T extends z.ZodTypeAny>(ctx: RunContext, key: string, options: ExecuteStepOptions<T>): string {
        const id = newId()
        sql.insertStep(this.db, {
            id,
            run_id: ctx.runId,
            key,
            name: options.name,
            seq: ctx.seq.next++,
            kind: options.kind,
            started_at: nowIso()
        })
        return id
    }

    private stepHandle(id: string, runId: string, key: string, signal: AbortSignal): StepHandle {
        return {
            stepId: id,
            stepKey: key,
            signal,
            set: (column, value) => {
                sql.setStepColumn(this.db, id, column, value)
                this.notifier.notify(runId)
            }
        }
    }

    private async runPreparedStep<T extends z.ZodTypeAny>(
        options: ExecuteStepOptions<T>,
        io: SchemaIo,
        step: PreparedStep
    ): Promise<z.infer<T>> {
        this.active.steps.add(step.id)
        this.notifier.notify(step.runId)
        try {
            return await this.executePreparedStep(options, io, step)
        } finally {
            this.active.steps.delete(step.id)
            this.notifier.notify(step.runId)
        }
    }

    private async executePreparedStep<T extends z.ZodTypeAny>(
        options: ExecuteStepOptions<T>,
        io: SchemaIo,
        step: PreparedStep
    ): Promise<z.infer<T>> {
        let raw: unknown
        try {
            raw = await options.execute(step.handle)
        } catch (error) {
            if (step.handle.signal.aborted) return this.interruptPreparedStep(options, step)
            await this.failPreparedStep(options, step, error)
            throw error
        }
        if (step.handle.signal.aborted) return this.interruptPreparedStep(options, step)
        try {
            return await this.succeedPreparedStep(options, io, step, raw)
        } catch (error) {
            await this.failPreparedStep(options, step, error)
            throw error
        }
    }

    private async succeedPreparedStep<T extends z.ZodTypeAny>(
        options: ExecuteStepOptions<T>,
        io: SchemaIo,
        step: PreparedStep,
        raw: unknown
    ): Promise<z.infer<T>> {
        const output = parseStepOutput(options, raw)
        if (options.onSuccess) await options.onSuccess(step.handle, output)
        const persisted = io === "input" ? raw : output
        sql.succeedStep(this.db, step.id, persisted === undefined ? null : JSON.stringify(persisted), nowIso())
        return output
    }

    private async interruptPreparedStep<T extends z.ZodTypeAny>(
        options: ExecuteStepOptions<T>,
        step: PreparedStep
    ): Promise<never> {
        try {
            if (options.onInterrupt) await options.onInterrupt(step.handle)
        } catch {}
        throw step.handle.signal.reason
    }

    private async failPreparedStep<T extends z.ZodTypeAny>(
        options: ExecuteStepOptions<T>,
        step: PreparedStep,
        error: unknown
    ): Promise<void> {
        if (options.onError) await options.onError(step.handle)
        sql.failStep(this.db, step.id, errorMessage(error), errorCode(error), nowIso())
    }

    abortRun(runId: string, reason: ClankHouseError): void {
        const active = this.active.runs.get(runId)
        if (!active) return
        this.notifier.notify(runId)
        active.controller.abort(reason)
    }

    async prefix<O>(name: string, fn: () => Promise<O>): Promise<O> {
        const ctx = requireContext()
        return runContext.run({ ...ctx, prefixes: [...ctx.prefixes, name] }, fn)
    }
}

type PreparedStep = { id: string; runId: string; handle: StepHandle }

function validateStepSchema<T extends z.ZodTypeAny>(options: ExecuteStepOptions<T>): SchemaIo {
    const io = options.schemaIo ?? "output"
    jsonSchema({
        schema: options.schema,
        io,
        role: options.schemaRole ?? `Durable step "${options.name}" output schema`,
        allowTopLevelVoid: options.allowTopLevelVoid ?? true
    })
    return io
}

function parseStepOutput<T extends z.ZodTypeAny>(options: ExecuteStepOptions<T>, value: unknown): z.infer<T> {
    return options.parse ? options.parse(value) : options.schema.parse(value)
}

function errorCode(error: unknown) {
    return error instanceof ClankHouseError ? error.code : null
}
