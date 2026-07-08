import * as z from "zod"
import type { Loopy, RerunOptions } from "./loopy"
import { requireContext, runContext, type RunContext } from "./context"
import * as sql from "./db"
import type { Db, RunRow, StepColumn, StepKind, StepRow } from "./db"
import type { ActiveSets } from "./runtime"
import { copyFileSync, mkdirSync } from "node:fs"
import * as path from "node:path"
import { errorMessage, newId, nowIso } from "./util"
import { decode, encode } from "./codec"
import { artifactFile } from "./artifacts"

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

export type Plan =
    | { type: "execute"; runRow: RunRow }
    | { type: "noopRunning"; runId: string }
    | { type: "noopSucceeded"; runRow: RunRow }

export class Engine {
    private readonly db: Db
    private readonly active: ActiveSets
    private readonly loopyDir: string

    constructor(db: Db, active: ActiveSets, loopyDir: string) {
        this.db = db
        this.active = active
        this.loopyDir = loopyDir
    }

    resolvePlan(workflowName: string, key: string, input: unknown, rerun?: RerunOptions): Plan {
        const latest = sql.findLastAttempt(this.db, workflowName, key)
        const running = latest !== undefined && this.active.runs.has(latest.id)
        if (!rerun) return this.planFresh(workflowName, key, input, latest, running)
        if (running || latest?.status === "interrupted") {
            throw new Error(`Run "${key}" is still in progress; concurrent attempts are not allowed`)
        }
        if (!latest) throw new Error(`No run found for key "${key}" to rerun`)
        const fromStep = sql.findStep(this.db, latest.id, rerun.from)
        if (!fromStep) throw new Error(`Step "${rerun.from}" not found in the latest attempt of run "${key}"`)
        const runRow = this.insertRun(workflowName, key, latest.attempt + 1, input)
        this.reuseSteps(latest.id, fromStep.seq, runRow)
        return { type: "execute", runRow }
    }

    private planFresh(
        workflowName: string,
        key: string,
        input: unknown,
        latest: RunRow | undefined,
        running: boolean
    ): Plan {
        if (!latest) return { type: "execute", runRow: this.insertRun(workflowName, key, 1, input) }
        if (running) return { type: "noopRunning", runId: latest.id }
        switch (latest.status) {
            case "succeeded":
                return { type: "noopSucceeded", runRow: latest }
            case "interrupted":
                return { type: "execute", runRow: latest }
            case "failed":
                throw new Error(`Run "${key}" has failed; rerun with {from} to start a new attempt`)
        }
    }

    private reuseSteps(previousRunId: string, fromSeq: number, runRow: RunRow): void {
        for (const step of sql.findStepsBefore(this.db, previousRunId, fromSeq)) {
            if (step.status === "succeeded") this.reuseSucceededStep(step, runRow)
            else sql.copyStep(this.db, { ...step, id: newId(), run_id: runRow.id })
        }
    }

    private reuseSucceededStep(s: StepRow, runRow: RunRow): void {
        const db = this.db
        let artifactId = s.artifact_id
        let output = s.output
        if (artifactId !== null) {
            const artifact = sql.findArtifactById(db, artifactId)!
            artifactId = newId()
            const file = artifactFile(runRow.id, s.key)
            this.copyArtifactFile(artifact.file, file)
            sql.insertArtifact(db, { ...artifact, id: artifactId, run_id: runRow.id, file })
            if (output !== null) output = encode({ ...decode(output), id: artifactId, runId: runRow.id, file })
        }
        sql.copyStep(db, { ...s, id: newId(), run_id: runRow.id, artifact_id: artifactId, output })
    }

    private copyArtifactFile(from: string, to: string): void {
        const dest = path.join(this.loopyDir, to)
        mkdirSync(path.dirname(dest), { recursive: true })
        copyFileSync(path.join(this.loopyDir, from), dest)
    }

    private insertRun(workflowName: string, key: string, attempt: number, input: unknown): RunRow {
        const row: RunRow = {
            id: newId(),
            key,
            attempt,
            workflow_name: workflowName,
            input: input === undefined ? null : encode(input),
            output: null,
            error: null,
            status: "interrupted",
            started_at: nowIso(),
            ended_at: null
        }
        sql.insertRun(this.db, row)
        return row
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
            .finally(() => this.active.runs.delete(runRow.id))
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
        const handle: StepHandle = {
            stepId: id,
            stepKey: key,
            set(column, value) {
                sql.setStepColumn(db, id, column, value)
            }
        }
        this.active.steps.add(id)
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
        }
    }

    async prefix<O>(name: string, fn: () => Promise<O>): Promise<O> {
        const ctx = requireContext()
        return runContext.run({ ...ctx, prefixes: [...ctx.prefixes, name] }, fn)
    }
}
