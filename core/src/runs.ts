import { toArtifact, type Artifact } from "./artifacts"
import * as sql from "./db"
import { LoopyError } from "./errors"
import type { LoopyErrorCode } from "./errors"
import { observableStatus, type ActiveSets } from "./runtime"
import type { Db, ListRunsFilter, RunRow, StepRow } from "./db"
import type { WorktreeReference } from "./git"
import { watch, type Notifier } from "./watch"

export class WorkflowRuns {
    private readonly db: Db
    private readonly active: ActiveSets
    private readonly notifier: Notifier

    constructor(db: Db, active: ActiveSets, notifier: Notifier) {
        this.db = db
        this.active = active
        this.notifier = notifier
    }

    async list(options?: ListWorkflowOptions): Promise<WorkflowRunMetadata[]> {
        const statuses = options?.statuses
        const needsOverlayFilter =
            statuses !== undefined && statuses.includes("interrupted") !== statuses.includes("running")
        const rows = sql.listRuns(this.db, this.createDbFilter(options, needsOverlayFilter))
        const result = rows.map((row) => this.toMetadata(row))
        return this.applyOverlayFilter(result, options, needsOverlayFilter)
    }

    private createDbFilter(options: ListWorkflowOptions | undefined, needsOverlayFilter: boolean): ListRunsFilter {
        const filter: ListRunsFilter = {}
        if (options?.key !== undefined) filter.key = options.key
        if (options?.workflowName !== undefined) filter.workflowName = options.workflowName
        if (options?.statuses !== undefined)
            filter.statuses = [...new Set(options.statuses.map((s) => (s === "running" ? "interrupted" : s)))]
        if (options?.lastN !== undefined && !needsOverlayFilter) filter.lastN = options.lastN
        return filter
    }

    private applyOverlayFilter(
        result: WorkflowRunMetadata[],
        options: ListWorkflowOptions | undefined,
        needsOverlayFilter: boolean
    ): WorkflowRunMetadata[] {
        if (!needsOverlayFilter) return result
        const filtered = result.filter((m) => options!.statuses!.includes(m.status))
        return options?.lastN !== undefined ? filtered.slice(0, options.lastN) : filtered
    }

    async get(id: string): Promise<WorkflowRun> {
        const row = sql.findRunById(this.db, id)
        if (!row) throw new LoopyError("workflow_run_not_found", `Workflow run not found: ${id}`)
        const stepRows = sql.findStepsByRun(this.db, id)
        const artifactRows = sql.findArtifactsByRun(this.db, id)
        return {
            ...this.toMetadata(row),
            ...(row.output !== null ? { output: JSON.parse(row.output), outputJson: row.output } : {}),
            ...(row.error !== null ? { error: row.error } : {}),
            ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
            steps: stepRows.map((s) => this.toStep(s)),
            artifacts: artifactRows.map(toArtifact)
        }
    }

    /**
     * Streams step and run updates.
     * Step updates are yielded as they arrive, while run updates are yielded when
     * a run stops (succeeded, failed, or interrupted).
     *
     * Parameter `fromStepId` is inclusive as the step's state may have changed.
     *
     * Note: failed runs are reported as soon as the run fails. A parallel step may still be
     * in progress and will still be yielded, unless canceled.
     */
    async *stream(
        runId: string,
        options?: { fromStepId?: string; signal?: AbortSignal }
    ): AsyncGenerator<RunStreamItem, void, void> {
        if (!sql.findRunById(this.db, runId)) {
            throw new LoopyError("workflow_run_not_found", `Workflow run not found: ${runId}`)
        }
        const seen = new Map<string, string>()
        let watermark = this.resolveWatermark(runId, options?.fromStepId)
        let sawActiveStep = false
        let reportedStatus: ObservableRunStatus = "running"

        const changedSteps = (rows: StepRow[]): Step[] => {
            sawActiveStep = rows.some((row) => this.active.steps.has(row.id))
            const changed: Step[] = []
            for (const row of rows) {
                const fp = fingerprint(row, observableStatus(row.status, this.active.steps.has(row.id)))
                if (seen.get(row.id) === fp) continue
                seen.set(row.id, fp)
                changed.push(this.toStep(row))
            }
            return changed
        }

        const forgetSucceededPrefix = (rows: StepRow[]): void => {
            for (const row of rows) {
                if (row.status !== "succeeded") return
                watermark = row.seq + 1
                seen.delete(row.id)
            }
        }

        const settledRunStatus = (): WorkflowRunMetadata | undefined => {
            const runRow = sql.findRunById(this.db, runId)!
            const status = observableStatus(runRow.status, this.active.runs.has(runId))
            if (status === "running" || status === reportedStatus) return undefined
            reportedStatus = status
            return this.toMetadata(runRow)
        }

        const drain = (): RunStreamItem[] => {
            const rows = sql.findStepsFrom(this.db, runId, watermark)
            const items: RunStreamItem[] = changedSteps(rows)
            forgetSucceededPrefix(rows)
            const settled = settledRunStatus()
            if (settled) items.push(settled)
            return items
        }

        yield* watch(this.notifier, runId, drain, () => this.active.runs.has(runId) || sawActiveStep, options?.signal)
    }

    private resolveWatermark(runId: string, fromStepId: string | undefined): number {
        if (fromStepId === undefined) return 0
        const row = sql.findStepById(this.db, fromStepId)
        if (!row || row.run_id !== runId) {
            throw new LoopyError("workflow_step_not_found", `Step not found in run ${runId}: ${fromStepId}`)
        }
        return row.seq
    }

    private toMetadata(row: RunRow): WorkflowRunMetadata {
        return {
            id: row.id,
            key: row.key,
            attempt: row.attempt,
            workflowName: row.workflow_name,
            startedAt: new Date(row.started_at),
            ...(row.ended_at !== null ? { endedAt: new Date(row.ended_at) } : {}),
            status: observableStatus(row.status, this.active.runs.has(row.id))
        }
    }

    private toStep(row: StepRow): Step {
        const base = {
            id: row.id,
            runId: row.run_id,
            key: row.key,
            name: row.name,
            seq: row.seq,
            status: observableStatus(row.status, this.active.steps.has(row.id)),
            startedAt: new Date(row.started_at),
            ...(row.ended_at !== null ? { endedAt: new Date(row.ended_at) } : {}),
            ...(row.error !== null ? { error: row.error } : {}),
            ...(row.error_code !== null ? { errorCode: row.error_code } : {})
        }
        const output = row.output !== null ? JSON.parse(row.output) : undefined
        const outputJson = row.output ?? undefined
        switch (row.kind) {
            case "custom":
                return { ...base, kind: "custom", output, ...(outputJson !== undefined ? { outputJson } : {}) }
            case "artifact":
                return {
                    ...base,
                    kind: "artifact",
                    output,
                    ...(outputJson !== undefined ? { outputJson } : {}),
                    ...(row.artifact_id !== null ? { artifactId: row.artifact_id } : {})
                }
            case "llm":
                return {
                    ...base,
                    kind: "llm",
                    output,
                    ...(outputJson !== undefined ? { outputJson } : {}),
                    ...(row.session_id !== null ? { sessionId: row.session_id } : {})
                }
            case "agent":
                return {
                    ...base,
                    kind: "agent",
                    output,
                    ...(outputJson !== undefined ? { outputJson } : {}),
                    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
                    ...(row.snapshot_ref !== null ? { snapshotRef: row.snapshot_ref } : {})
                }
            case "event":
                return {
                    ...base,
                    kind: "event",
                    output,
                    ...(outputJson !== undefined ? { outputJson } : {}),
                    ...(row.event_key !== null ? { eventKey: row.event_key } : {})
                }
            case "worktree":
                return { ...base, kind: "worktree", output, ...(outputJson !== undefined ? { outputJson } : {}) }
        }
    }
}

function fingerprint(row: StepRow, status: ObservableStepStatus): string {
    return JSON.stringify([
        status,
        row.output,
        row.error,
        row.error_code,
        row.session_id,
        row.snapshot_ref,
        row.artifact_id,
        row.event_key,
        row.started_at,
        row.ended_at
    ])
}

// persisted state is never "running" -> "running" stuff is in-memory only and "overlayed" on top of "interrupted"
export type PersistedStepStatus = "interrupted" | "succeeded" | "failed"

export type ObservableStepStatus = PersistedStepStatus | "running"

type StepBase = {
    id: string
    runId: string
    key: string
    name: string
    seq: number
    startedAt: Date
    endedAt?: Date
    status: ObservableStepStatus
    error?: string
    errorCode?: LoopyErrorCode
    outputJson?: string
}

export type CustomStep = StepBase & { kind: "custom"; output?: unknown }
export type ArtifactStep = StepBase & { kind: "artifact"; artifactId?: string; output?: Artifact }
export type LlmStep = StepBase & { kind: "llm"; sessionId?: string; output?: unknown }
export type AgentStep = StepBase & {
    kind: "agent"
    sessionId?: string
    snapshotRef?: string
    output?: unknown
    outputJson?: string
}
export type EventStep = StepBase & { kind: "event"; eventKey?: string; output?: unknown }
export type WorktreeStep = StepBase & { kind: "worktree"; output?: WorktreeReference }

export type Step = CustomStep | ArtifactStep | LlmStep | AgentStep | EventStep | WorktreeStep

// persisted state is never "running" -> "running" stuff is in-memory only and "overlayed" on top of "interrupted"
export type PersistedRunStatus = "interrupted" | "succeeded" | "failed"

export type ObservableRunStatus = PersistedRunStatus | "running"

export type WorkflowRun = {
    /**
     * Unique, URL-friendly run ID.
     */
    id: string
    /**
     * Semantic ID, reused across attempts.
     */
    key: string
    /**
     * Attempt number. (workflowName, key, attempt) tuple is always unique.
     */
    attempt: number
    workflowName: string
    startedAt: Date
    endedAt?: Date
    status: ObservableRunStatus
    output?: unknown
    outputJson?: string
    error?: string
    errorCode?: LoopyErrorCode
    steps: Step[]
    artifacts: Artifact[]
}

export type WorkflowRunMetadata = {
    id: string
    key: string
    attempt: number
    workflowName: string
    startedAt: Date
    endedAt?: Date
    status: ObservableRunStatus
}

export type RunStreamItem = Step | WorkflowRunMetadata

export type ListWorkflowOptions = {
    key?: string
    workflowName?: string
    statuses?: ObservableRunStatus[]
    lastN?: number
}
