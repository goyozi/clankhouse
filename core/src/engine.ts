import * as z from "zod"
import type { Loopy } from "./loopy"
import { requireContext, runContext, type RunContext } from "./context"
import * as sql from "./db"
import type { Db, RunRow, StepColumn, StepKind, StepRow } from "./db"
import type { ActiveSets } from "./runtime"
import type { Notifier } from "./watch"
import { errorMessage, newId, nowIso } from "./util"
import { decode, encode } from "./codec"

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
    execute: (handle: StepHandle) => Promise<unknown>
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

    executeRun<O>(loopy: Loopy, runRow: RunRow, fn: () => Promise<O>): Promise<O> {
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
            .then(
                (output) => {
                    sql.succeedRun(db, runRow.id, output === undefined ? null : encode(output), nowIso())
                    return output
                },
                (e) => {
                    sql.failRun(db, runRow.id, errorMessage(e), nowIso())
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
        const ctx = requireContext()
        const db = this.db
        const key = [...ctx.prefixes, options.name].join("/")
        if (ctx.seenStepKeys.has(key)) {
            throw new Error(`Duplicate step "${key}" in run "${ctx.runKey}"`)
        }
        ctx.seenStepKeys.add(key)
        const existing = sql.findStep(db, ctx.runId, key)
        if (existing?.status === "succeeded") {
            const output = options.schema.parse(existing.output === null ? undefined : decode(existing.output))
            if (options.onReplay) await options.onReplay(existing)
            return output
        }
        let id: string
        if (existing) {
            id = existing.id
            sql.resetStep(db, id, nowIso())
        } else {
            id = newId()
            sql.insertStep(db, {
                id,
                run_id: ctx.runId,
                key,
                name: options.name,
                seq: ctx.seq.next++,
                kind: options.kind,
                started_at: nowIso()
            })
        }
        const notifier = this.notifier
        const runId = ctx.runId
        const handle: StepHandle = {
            stepId: id,
            stepKey: key,
            set(column, value) {
                sql.setStepColumn(db, id, column, value)
                notifier.notify(runId)
            }
        }
        this.active.steps.add(id)
        this.notifier.notify(runId)
        try {
            const output = options.schema.parse(await options.execute(handle))
            if (options.onSuccess) await options.onSuccess(handle, output)
            sql.succeedStep(db, id, output === undefined ? null : encode(output), nowIso())
            return output
        } catch (e) {
            if (options.onError) await options.onError(handle)
            sql.failStep(db, id, errorMessage(e), nowIso())
            throw e
        } finally {
            this.active.steps.delete(id)
            this.notifier.notify(runId)
        }
    }

    async prefix<O>(name: string, fn: () => Promise<O>): Promise<O> {
        const ctx = requireContext()
        return runContext.run({ ...ctx, prefixes: [...ctx.prefixes, name] }, fn)
    }
}
