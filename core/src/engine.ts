import * as z from "zod"
import type { Loopy } from "./loopy"
import { requireContext, runContext, type RunContext } from "./context"
import * as sql from "./db"
import type { Db, RunRow, StepColumn, StepKind, StepRow } from "./db"
import type { ActiveSets } from "./runtime"
import type { Notifier } from "./watch"
import { LoopyError } from "./errors"
import { errorMessage, newId, nowIso } from "./util"
import { jsonSchema, type SchemaIo } from "./json-schema"

export type { StepColumn } from "./db"

export type StepHandle = {
    readonly stepId: string
    readonly stepKey: string
    set(column: StepColumn, value: string): void
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
        loopy: Loopy,
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
            loopy,
            runId: runRow.id,
            runKey: runRow.key,
            workflowName: runRow.workflow_name,
            attempt: runRow.attempt,
            prefixes: [],
            seenStepKeys: new Set(),
            seq: { next: maxSeq + 1 }
        }
        const promise = Promise.resolve()
            .then(() => runContext.run(ctx, fn))
            .then((value) => output.parse(value))
            .then(
                (value) => {
                    sql.succeedRun(db, runRow.id, value === undefined ? null : JSON.stringify(value), nowIso())
                    return value
                },
                (e) => {
                    sql.failRun(db, runRow.id, errorMessage(e), errorCode(e), nowIso())
                    throw e
                }
            )
            .finally(() => {
                this.active.runs.delete(runRow.id)
                this.notifier.notify(runRow.id)
            })
        this.active.runs.set(runRow.id, { promise })
        return promise
    }

    async executeStep<T extends z.ZodTypeAny>(options: ExecuteStepOptions<T>): Promise<z.infer<T>> {
        const io = validateStepSchema(options)
        const ctx = requireContext()
        const key = this.claimStepKey(ctx, options.name)
        const existing = sql.findStep(this.db, ctx.runId, key)
        if (existing?.status === "succeeded") return this.replayStep(options, existing)
        const prepared = this.prepareStep(ctx, key, options, existing)
        return this.runPreparedStep(options, io, prepared)
    }

    private claimStepKey(ctx: RunContext, name: string): string {
        const key = [...ctx.prefixes, name].join("/")
        if (ctx.seenStepKeys.has(key)) {
            throw new LoopyError("workflow_step_duplicate", `Duplicate step "${key}" in run "${ctx.runKey}"`)
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
        return { id, runId: ctx.runId, handle: this.stepHandle(id, ctx.runId, key) }
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

    private stepHandle(id: string, runId: string, key: string): StepHandle {
        return {
            stepId: id,
            stepKey: key,
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
        } catch (error) {
            await this.failPreparedStep(options, step, error)
            throw error
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
        const raw = await options.execute(step.handle)
        const output = parseStepOutput(options, raw)
        if (options.onSuccess) await options.onSuccess(step.handle, output)
        const persisted = io === "input" ? raw : output
        sql.succeedStep(this.db, step.id, persisted === undefined ? null : JSON.stringify(persisted), nowIso())
        return output
    }

    private async failPreparedStep<T extends z.ZodTypeAny>(
        options: ExecuteStepOptions<T>,
        step: PreparedStep,
        error: unknown
    ): Promise<void> {
        if (options.onError) await options.onError(step.handle)
        sql.failStep(this.db, step.id, errorMessage(error), errorCode(error), nowIso())
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
    return error instanceof LoopyError ? error.code : null
}
