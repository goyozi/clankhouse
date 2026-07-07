import type { Artifact } from "./artifacts";
import * as sql from "./db";
import { decode } from "./codec";
import type { DatabaseSync } from "node:sqlite";
import { observableStatus, type ActiveSets } from "./runtime";
import type { ArtifactRow, ListRunsFilter, RunRow, StepRow } from "./db";

export class WorkflowRuns {
    private readonly db: DatabaseSync
    private readonly active: ActiveSets

    constructor(db: DatabaseSync, active: ActiveSets) {
        this.db = db
        this.active = active
    }

    async list(options?: ListWorkflowOptions): Promise<WorkflowRunMetadata[]> {
        const statuses = options?.statuses
        const needsOverlayFilter = statuses !== undefined && statuses.includes("interrupted") !== statuses.includes("running")
        const rows = sql.listRuns(this.db, this.createDbFilter(options, needsOverlayFilter))
        const result = rows.map(row => this.toMetadata(row))
        return this.applyOverlayFilter(result, options, needsOverlayFilter)
    }

    private createDbFilter(options: ListWorkflowOptions | undefined, needsOverlayFilter: boolean): ListRunsFilter {
        const filter: ListRunsFilter = {}
        if (options?.key !== undefined) filter.key = options.key
        if (options?.workflowName !== undefined) filter.workflowName = options.workflowName
        if (options?.statuses !== undefined) filter.statuses = [...new Set(options.statuses.map(s => s === "running" ? "interrupted" : s))]
        if (options?.lastN !== undefined && !needsOverlayFilter) filter.lastN = options.lastN
        return filter
    }

    private applyOverlayFilter(result: WorkflowRunMetadata[], options: ListWorkflowOptions | undefined, needsOverlayFilter: boolean): WorkflowRunMetadata[] {
        if (!needsOverlayFilter) return result
        const filtered = result.filter(m => options!.statuses!.includes(m.status))
        return options?.lastN !== undefined ? filtered.slice(0, options.lastN) : filtered
    }

    async get(id: string): Promise<WorkflowRun> {
        const row = sql.findRunById(this.db, id)
        if (!row) throw new Error(`Workflow run not found: ${id}`)
        const stepRows = sql.findStepsByRun(this.db, id)
        const artifactRows = sql.findArtifactsByRun(this.db, id)
        return {
            ...this.toMetadata(row),
            ...(row.output !== null ? { output: decode(row.output) } : {}),
            ...(row.error !== null ? { error: row.error } : {}),
            steps: stepRows.map(s => this.toStep(s)),
            artifacts: artifactRows.map(a => this.toArtifact(a))
        }
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
            ...(row.error !== null ? { error: row.error } : {})
        }
        const output = row.output !== null ? decode(row.output) : undefined
        switch (row.kind) {
            case "custom":
                return { ...base, kind: "custom", output }
            case "artifact":
                return { ...base, kind: "artifact", output, ...(row.artifact_id !== null ? { artifactId: row.artifact_id } : {}) }
            case "llm":
                return { ...base, kind: "llm", output, ...(row.session_id !== null ? { sessionId: row.session_id } : {}) }
            case "agent":
                return {
                    ...base,
                    kind: "agent",
                    output,
                    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
                    ...(row.snapshot_ref !== null ? { snapshotRef: row.snapshot_ref } : {})
                }
            case "event":
                return { ...base, kind: "event", output, ...(row.event_key !== null ? { eventKey: row.event_key } : {}) }
        }
    }

    private toArtifact(row: ArtifactRow): Artifact {
        return {
            id: row.id,
            runId: row.run_id,
            name: row.name,
            file: row.file,
            kind: row.kind,
            ...(row.mime_type !== null ? { mimeType: row.mime_type } : {})
        }
    }
}

// persisted state is never "running" -> "running" stuff is in-memory only and "overlayed" on top of "interrupted"
export type PersistedStepStatus = "interrupted" | "succeeded" | "failed"

export type ObservableStepStatus = PersistedStepStatus | "running"

type StepBase = {
    id: string,
    runId: string,
    key: string,
    name: string,
    seq: number,
    startedAt: Date,
    endedAt?: Date,
    status: ObservableStepStatus,
    error?: string
}

export type CustomStep = StepBase & { kind: "custom", output?: unknown }
export type ArtifactStep = StepBase & { kind: "artifact", artifactId?: string, output?: Artifact }
export type LlmStep = StepBase & { kind: "llm", sessionId?: string, output?: unknown }
export type AgentStep = StepBase & { kind: "agent", sessionId?: string, snapshotRef?: string, output?: unknown }
export type EventStep = StepBase & { kind: "event", eventKey?: string, output?: unknown }

export type Step = CustomStep | ArtifactStep | LlmStep | AgentStep | EventStep

// persisted state is never "running" -> "running" stuff is in-memory only and "overlayed" on top of "interrupted"
export type PersistedRunStatus = "interrupted" | "succeeded" | "failed"

export type ObservableRunStatus = PersistedRunStatus | "running"

export type WorkflowRun = {
    /**
     * Unique, URL-friendly run ID.
     */
    id: string,
    /**
     * Semantic ID, reused across attempts.
     */
    key: string,
    /**
     * Attempt number. (workflowName, key, attempt) tuple is always unique.
     */
    attempt: number,
    workflowName: string,
    startedAt: Date,
    endedAt?: Date,
    status: ObservableRunStatus,
    output?: unknown,
    error?: string,
    steps: Step[],
    artifacts: Artifact[]
}

export type WorkflowRunMetadata = {
    id: string,
    key: string,
    attempt: number,
    workflowName: string,
    startedAt: Date,
    endedAt?: Date,
    status: ObservableRunStatus
}

export type ListWorkflowOptions = {
    key?: string,
    workflowName?: string,
    statuses?: ObservableRunStatus[],
    lastN?: number
}
