import * as z from "zod"
import type { Loopy } from "./loopy"
import type { Engine } from "./engine"
import type { ActiveSets } from "./runtime"
import * as sql from "./db"
import type { Db, RunRow, StepRow } from "./db"
import type { Artifacts } from "./artifacts"
import { LoopyError } from "./errors"
import { jsonSchema } from "./json-schema"
import { newId, nowIso } from "./util"

export class Workflows {
    private readonly loopy: Loopy
    private readonly db: Db
    private readonly engine: Engine
    private readonly active: ActiveSets
    private readonly artifacts: Artifacts
    private readonly registered = new Map<string, RegisteredWorkflow>()

    constructor(loopy: Loopy, db: Db, engine: Engine, active: ActiveSets, artifacts: Artifacts) {
        this.loopy = loopy
        this.db = db
        this.engine = engine
        this.active = active
        this.artifacts = artifacts
    }

    register<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
        name: string,
        options: WorkflowOptions<I, O>,
        workflowFn: (input: z.infer<I>) => Promise<z.infer<O>>
    ): void {
        if (this.registered.has(name)) {
            throw new LoopyError("workflow_already_registered", `Workflow "${name}" is already registered`)
        }
        const inputSchema = jsonSchema({
            schema: options.input,
            io: "input",
            role: `Workflow "${name}" input schema`
        })!
        const outputSchema = jsonSchema({
            schema: options.output,
            io: "output",
            role: `Workflow "${name}" output schema`,
            allowTopLevelVoid: true
        })
        this.registered.set(name, { options, fn: workflowFn, inputSchema, outputSchema })
    }

    list(): WorkflowSummary[] {
        return [...this.registered.keys()].sort().map((name) => ({ name }))
    }

    get(name: string): WorkflowDefinition {
        const registered = this.requireRegistered(name)
        return {
            name,
            inputSchema: registered.inputSchema,
            ...(registered.outputSchema !== undefined ? { outputSchema: registered.outputSchema } : {})
        }
    }

    start(name: string, input: any): string {
        const registered = this.requireRegistered(name)
        const parsed = registered.options.input.parse(input)
        const inputJson = JSON.stringify(input)
        const plan = this.resolveStart({
            workflowName: name,
            value: registered.options.key(parsed),
            input: inputJson === undefined ? null : inputJson
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

    async run<T extends z.ZodTypeAny>(
        name: string,
        key: string,
        output: T,
        workflowFn: () => Promise<z.infer<T>>
    ): Promise<z.infer<T>> {
        jsonSchema({
            schema: output,
            io: "output",
            role: `Workflow "${name}" output schema`,
            allowTopLevelVoid: true
        })
        const plan = this.resolveStart({ workflowName: name, value: key, input: null })
        switch (plan.type) {
            case "noopRunning":
                return this.active.runs.get(plan.runRow.id)!.promise as Promise<z.infer<T>>
            case "noopSucceeded":
                return output.parse(plan.runRow.output === null ? undefined : JSON.parse(plan.runRow.output))
            case "execute":
                return this.engine.executeRun(this.loopy, plan.runRow, output, workflowFn)
        }
    }

    private dispatchRegistered(runRow: RunRow, registered: RegisteredWorkflow, input: any): void {
        this.engine
            .executeRun(this.loopy, runRow, registered.options.output, () => registered.fn(input))
            .catch(() => {})
    }

    private parseStoredInput(registered: RegisteredWorkflow, runRow: RunRow): any {
        return registered.options.input.parse(this.storedInput(runRow))
    }

    private storedInput(runRow: RunRow): unknown {
        return runRow.input === null ? undefined : JSON.parse(runRow.input)
    }

    private requireRegistered(name: string): RegisteredWorkflow {
        const registered = this.registered.get(name)
        if (!registered) {
            throw new LoopyError("workflow_not_registered", `Workflow "${name}" is not registered`)
        }
        return registered
    }

    private requireRun(id: string): RunRow {
        const row = sql.findRunById(this.db, id)
        if (!row) throw new LoopyError("workflow_run_not_found", `Workflow run not found: ${id}`)
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
                throw new LoopyError(
                    "workflow_run_failed",
                    `Run "${target.value}" has failed; rerun it from a step to start a new attempt`
                )
        }
    }

    private resolveResume(sourceRun: RunRow): Plan {
        if (this.active.runs.has(sourceRun.id)) return { type: "noopRunning", runRow: sourceRun }
        if (sourceRun.status !== "interrupted") {
            throw new LoopyError(
                "workflow_run_not_resumable",
                `Run "${sourceRun.id}" has ${sourceRun.status} and cannot be resumed`
            )
        }
        return { type: "execute", runRow: sourceRun, isNew: false }
    }

    private resolveRerun(sourceRun: RunRow, from: string): Extract<Plan, { type: "execute" }> {
        if (this.active.runs.has(sourceRun.id) || sourceRun.status === "interrupted") {
            throw new LoopyError(
                "workflow_run_in_progress",
                `Run "${sourceRun.key}" is still in progress; concurrent attempts are not allowed`
            )
        }
        const fromStep = sql.findStep(this.db, sourceRun.id, from)
        if (!fromStep) {
            throw new LoopyError("workflow_step_not_found", `Step "${from}" not found in run "${sourceRun.id}"`)
        }
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
            throw new LoopyError(
                "workflow_run_not_latest",
                `Run "${sourceRun.id}" is not the latest attempt for key "${sourceRun.key}"`
            )
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
            error_code: null,
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
        const { artifactId, output } = this.artifacts.cloneStepArtifact(step, runRow.id)
        sql.copyStep(this.db, { ...step, id: newId(), run_id: runRow.id, artifact_id: artifactId, output })
    }
}

type RegisteredWorkflow = {
    options: { input: z.ZodTypeAny; output: z.ZodTypeAny; key: (input: any) => string }
    fn: (input: any) => Promise<any>
    inputSchema: z.core.JSONSchema.JSONSchema
    outputSchema?: z.core.JSONSchema.JSONSchema
}

export type WorkflowOptions<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
    input: I
    output: O
    key: (input: z.infer<I>) => string
}

export type RerunOptions = { from: string }

export type WorkflowSummary = { name: string }

export type WorkflowDefinition = WorkflowSummary & {
    inputSchema: z.core.JSONSchema.JSONSchema
    outputSchema?: z.core.JSONSchema.JSONSchema
}

type RunKey = { workflowName: string; value: string; input: string | null }

type Plan =
    | { type: "execute"; runRow: RunRow; isNew: boolean }
    | { type: "noopRunning"; runRow: RunRow }
    | { type: "noopSucceeded"; runRow: RunRow }
