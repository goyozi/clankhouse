import * as z from "zod"
import { copyFileSync, mkdirSync } from "node:fs"
import * as path from "node:path"
import type { Loopy } from "./loopy"
import type { Engine } from "./engine"
import type { ActiveSets } from "./runtime"
import * as sql from "./db"
import type { Db, RunRow, StepRow } from "./db"
import { decode, encode } from "./codec"
import { artifactFile } from "./artifacts"
import { newId, nowIso } from "./util"

export class Workflows {
    private readonly loopy: Loopy
    private readonly loopyDir: string
    private readonly db: Db
    private readonly engine: Engine
    private readonly active: ActiveSets
    private readonly registered = new Map<string, RegisteredWorkflow>()

    constructor(loopy: Loopy, loopyDir: string, db: Db, engine: Engine, active: ActiveSets) {
        this.loopy = loopy
        this.loopyDir = loopyDir
        this.db = db
        this.engine = engine
        this.active = active
    }

    register<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
        name: string,
        options: WorkflowOptions<I, O>,
        workflowFn: (input: z.infer<I>) => Promise<z.infer<O>>
    ): void {
        if (this.registered.has(name)) throw new Error(`Workflow "${name}" is already registered`)
        this.registered.set(name, { options, fn: workflowFn })
    }

    start(name: string, input: any): string {
        const registered = this.requireRegistered(name)
        const parsed = registered.options.input.parse(input)
        const plan = this.resolveStart({
            workflowName: name,
            value: registered.options.key(parsed),
            input: input === undefined ? null : encode(input)
        })
        if (plan.type === "execute") {
            const runInput = plan.isNew ? parsed : this.parseStoredInput(registered, plan.runRow)
            this.dispatchRegistered(plan.runRow, registered, runInput)
        }
        return plan.runRow.id
    }

    resume(runId: string): string {
        const sourceRun = this.requireLatest(runId)
        const registered = this.requireRegistered(sourceRun.workflow_name)
        const plan = this.resolveResume(sourceRun)
        if (plan.type === "execute") {
            const input = this.parseStoredInput(registered, plan.runRow)
            this.dispatchRegistered(plan.runRow, registered, input)
        }
        return plan.runRow.id
    }

    rerun(runId: string, options: RerunOptions): string {
        const sourceRun = this.requireLatest(runId)
        const registered = this.requireRegistered(sourceRun.workflow_name)
        const input = this.parseStoredInput(registered, sourceRun)
        const plan = this.resolveRerun(sourceRun, options.from)
        this.dispatchRegistered(plan.runRow, registered, input)
        return plan.runRow.id
    }

    async run<O>(name: string, key: string, workflowFn: () => Promise<O>): Promise<O> {
        const plan = this.resolveStart({ workflowName: name, value: key, input: null })
        switch (plan.type) {
            case "noopRunning":
                return this.active.runs.get(plan.runRow.id)!.promise as Promise<O>
            case "noopSucceeded":
                return plan.runRow.output === null ? (undefined as O) : decode(plan.runRow.output)
            case "execute":
                return this.engine.executeRun(this.loopy, plan.runRow, workflowFn)
        }
    }

    private dispatchRegistered(runRow: RunRow, registered: RegisteredWorkflow, input: any): void {
        this.engine
            .executeRun(this.loopy, runRow, async () => registered.options.output.parse(await registered.fn(input)))
            .catch(() => {})
    }

    private parseStoredInput(registered: RegisteredWorkflow, runRow: RunRow): any {
        return registered.options.input.parse(this.storedInput(runRow))
    }

    private storedInput(runRow: RunRow): unknown {
        return runRow.input === null ? undefined : decode(runRow.input)
    }

    private requireRegistered(name: string): RegisteredWorkflow {
        const registered = this.registered.get(name)
        if (!registered) throw new Error(`Workflow "${name}" is not registered`)
        return registered
    }

    private requireRun(id: string): RunRow {
        const row = sql.findRunById(this.db, id)
        if (!row) throw new Error(`Workflow run not found: ${id}`)
        return row
    }

    private resolveStart(target: RunKey): Plan {
        const sourceRun = sql.findLastAttempt(this.db, target.workflowName, target.value)
        if (!sourceRun) return { type: "execute", runRow: this.insertRun(target, 1), isNew: true }
        if (this.active.runs.has(sourceRun.id)) return { type: "noopRunning", runRow: sourceRun }
        switch (sourceRun.status) {
            case "succeeded":
                return { type: "noopSucceeded", runRow: sourceRun }
            case "interrupted":
                return { type: "execute", runRow: sourceRun, isNew: false }
            case "failed":
                throw new Error(`Run "${target.value}" has failed; rerun it from a step to start a new attempt`)
        }
    }

    private resolveResume(sourceRun: RunRow): Plan {
        if (this.active.runs.has(sourceRun.id)) return { type: "noopRunning", runRow: sourceRun }
        if (sourceRun.status !== "interrupted") {
            throw new Error(`Run "${sourceRun.id}" has ${sourceRun.status} and cannot be resumed`)
        }
        return { type: "execute", runRow: sourceRun, isNew: false }
    }

    private resolveRerun(sourceRun: RunRow, from: string): Extract<Plan, { type: "execute" }> {
        if (this.active.runs.has(sourceRun.id) || sourceRun.status === "interrupted") {
            throw new Error(`Run "${sourceRun.key}" is still in progress; concurrent attempts are not allowed`)
        }
        const fromStep = sql.findStep(this.db, sourceRun.id, from)
        if (!fromStep) throw new Error(`Step "${from}" not found in run "${sourceRun.id}"`)
        const runRow = this.insertRun(
            {
                workflowName: sourceRun.workflow_name,
                value: sourceRun.key,
                input: sourceRun.input
            },
            sourceRun.attempt + 1
        )
        this.reuseSteps(sourceRun.id, fromStep.seq, runRow)
        return { type: "execute", runRow, isNew: true }
    }

    private requireLatest(runId: string): RunRow {
        const sourceRun = this.requireRun(runId)
        const latest = sql.findLastAttempt(this.db, sourceRun.workflow_name, sourceRun.key)!
        if (latest.id !== sourceRun.id) {
            throw new Error(`Run "${sourceRun.id}" is not the latest attempt for key "${sourceRun.key}"`)
        }
        return sourceRun
    }

    private insertRun(target: RunKey, attempt: number): RunRow {
        const row: RunRow = {
            id: newId(),
            key: target.value,
            attempt,
            workflow_name: target.workflowName,
            input: target.input,
            output: null,
            error: null,
            status: "interrupted",
            started_at: nowIso(),
            ended_at: null
        }
        sql.insertRun(this.db, row)
        return row
    }

    private reuseSteps(previousRunId: string, fromSeq: number, runRow: RunRow): void {
        for (const step of sql.findStepsBefore(this.db, previousRunId, fromSeq)) {
            if (step.status === "succeeded") this.reuseSucceededStep(step, runRow)
            else sql.copyStep(this.db, { ...step, id: newId(), run_id: runRow.id })
        }
    }

    private reuseSucceededStep(step: StepRow, runRow: RunRow): void {
        let artifactId = step.artifact_id
        let output = step.output
        if (artifactId !== null) {
            const artifact = sql.findArtifactById(this.db, artifactId)!
            artifactId = newId()
            const file = artifactFile(runRow.id, step.key)
            const destination = path.join(this.loopyDir, file)
            mkdirSync(path.dirname(destination), { recursive: true })
            copyFileSync(path.join(this.loopyDir, artifact.file), destination)
            sql.insertArtifact(this.db, { ...artifact, id: artifactId, run_id: runRow.id, file })
            if (output !== null) output = encode({ ...decode(output), id: artifactId, runId: runRow.id, file })
        }
        sql.copyStep(this.db, { ...step, id: newId(), run_id: runRow.id, artifact_id: artifactId, output })
    }
}

type RegisteredWorkflow = {
    options: { input: z.ZodTypeAny; output: z.ZodTypeAny; key: (input: any) => string }
    fn: (input: any) => Promise<any>
}

export type WorkflowOptions<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
    input: I
    output: O
    key: (input: z.infer<I>) => string
}

export type RerunOptions = { from: string }

type RunKey = { workflowName: string; value: string; input: string | null }

type Plan =
    | { type: "execute"; runRow: RunRow; isNew: boolean }
    | { type: "noopRunning"; runRow: RunRow }
    | { type: "noopSucceeded"; runRow: RunRow }
