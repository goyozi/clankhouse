import { timestampDate } from "@bufbuild/protobuf/wkt"
import {
    ExecutionStatus,
    StepKind,
    type GetRunResponse,
    type ListRunsResponse,
    type RunMetadata,
    type Session,
    type SessionMessage,
    type Step,
    type WorkflowRun
} from "@clankhouse/server/proto"
import { executionStatus, executionTiming, indent, prettyJson, table, timestamp } from "../../output"
import { formatArtifactValue } from "../artifacts"
import { formatAlignedSessionMessage, formatSessionMessage, type SessionFormatOptions } from "../sessions/output"

export function formatRunId(runId: string): string {
    return `${runId}\n`
}

export function formatRunOutput(outputJson: string): string {
    return `${outputJson}\n`
}

export function formatRuns(response: ListRunsResponse): string {
    if (response.runs.length === 0) return "No runs found.\n"
    return table(
        ["ID", "WORKFLOW", "KEY", "ATTEMPT", "STATUS", "STARTED", "ENDED"],
        response.runs.map((run) => [
            run.id,
            run.workflowName,
            run.key,
            String(run.attempt),
            executionStatus(run.status),
            timestamp(run.startedAt),
            timestamp(run.endedAt)
        ])
    )
}

export function formatRun(
    response: GetRunResponse,
    sessions: ReadonlyMap<string, Session> = new Map(),
    options: SessionFormatOptions = {}
): string {
    if (response.run === undefined) return "Run response is empty.\n"
    return formatWorkflowRun(response.run, sessions, options)
}

export function formatRunActivityHeader(response: GetRunResponse): string {
    const run = response.run
    if (run?.metadata === undefined) return "Run metadata is missing.\n\nActivity\n"
    return `${formatRunHeader(run.metadata, new Date()).join("\n")}\n\nActivity\n`
}

export function formatSessionErrorPrefix(sessionId: string): string {
    return `session ${sessionId}: `
}

function formatWorkflowRun(
    run: WorkflowRun,
    sessions: ReadonlyMap<string, Session>,
    options: SessionFormatOptions
): string {
    const metadata = run.metadata
    const now = new Date()
    const lines =
        metadata === undefined
            ? ["Run metadata is missing."]
            : formatRunHeader(metadata, now, run.steps.filter((step) => step.status === ExecutionStatus.RUNNING).length)
    if (run.errorCode !== undefined) lines.push(indent(`Error code ${run.errorCode}`))
    if (run.error !== undefined) lines.push(indent(`Error ${run.error}`))
    lines.push("", "Steps")
    if (run.steps.length === 0) {
        lines.push("  None")
    } else {
        for (const [index, step] of run.steps.entries()) {
            if (index > 0) lines.push("")
            lines.push(...formatStep(step, sessions, now, options))
        }
    }
    lines.push("", "Artifacts")
    if (run.artifacts.length === 0) {
        lines.push("  None")
    } else {
        for (const artifact of run.artifacts) lines.push(indent(formatArtifactValue(artifact), 1))
    }
    if (run.outputJson !== undefined) lines.push("", "Output", indent(prettyJson(run.outputJson)))
    return `${lines.join("\n")}\n`
}

function formatStep(
    step: Step,
    sessions: ReadonlyMap<string, Session>,
    now: Date,
    options: SessionFormatOptions
): string[] {
    const lines = [
        indent(`${stepNumber(step)}. ${step.key}`),
        nestedLine(`${stepKind(step.kind)} · ${formatExecution(step.status, step.startedAt, step.endedAt, now)}`, 2)
    ]
    if (step.sessionId !== undefined) {
        lines.push("")
        const session = sessions.get(step.sessionId)
        if (session === undefined) lines.push(nestedLine(`Session ${step.sessionId}`, 2))
        else lines.push(...formatIncludedSession(session, options))
    }

    const references = [
        ...(step.artifactId === undefined ? [] : [`Artifact ${step.artifactId}`]),
        ...(step.eventKey === undefined ? [] : [`Event ${step.eventKey}`]),
        ...(step.snapshotRef === undefined ? [] : [`Snapshot ${step.snapshotRef}`])
    ]
    if (references.length > 0) lines.push("", ...references.map((value) => nestedLine(value, 2)))

    const errors = [
        ...(step.errorCode === undefined ? [] : [`Error code ${step.errorCode}`]),
        ...(step.error === undefined ? [] : [`Error ${step.error}`])
    ]
    if (errors.length > 0) lines.push("", ...errors.map((value) => nestedLine(value, 2)))

    if (step.outputJson !== undefined) {
        lines.push("", nestedLine("Output", 2), nestedLines(prettyJson(step.outputJson), 3))
    }
    return lines
}

function formatIncludedSession(session: Session, options: SessionFormatOptions): string[] {
    const lines = [
        nestedLine(`Session ${session.id}`, 2),
        nestedLine(`${session.client} · ${session.provider}/${session.model}`, 3),
        "",
        nestedLine("Messages", 3)
    ]
    const messages = session.messages.flatMap((message) => formatIncludedSessionMessage(message, options))
    if (messages.length === 0) lines.push(nestedLine("None", 4))
    else lines.push(...messages.map((value) => nestedLine(value, 4)))
    return lines
}

function formatIncludedSessionMessage(message: Session["messages"][number], options: SessionFormatOptions): string[] {
    return formatAlignedSessionMessage(message, options)
}

function formatExecution(
    status: ExecutionStatus,
    startedAt: RunMetadata["startedAt"],
    endedAt: RunMetadata["endedAt"],
    now: Date
): string {
    const timing = executionTiming(startedAt, endedAt, now)
    return timing === undefined ? executionStatus(status) : `${executionStatus(status)} · ${timing}`
}

function nestedLine(value: string, levels: number): string {
    return nestedLines(value, levels)
}

function nestedLines(value: string, levels: number): string {
    const prefix = `${"  ".repeat(levels)} `
    return value
        .split("\n")
        .map((line) => (line.length === 0 ? "" : `${prefix}${line}`))
        .join("\n")
}

export class RunActivityFormatter {
    private readonly renderedSteps = new Map<string, string>()
    private readonly stepsBySession = new Map<string, Step>()
    private readonly sessions = new Map<string, Session>()
    private readonly introducedSessions = new Set<string>()
    private currentOwner: string | undefined
    private activityStarted = false
    private lastDetail: "session" | "other" = "other"
    private readonly sessionFormatOptions: SessionFormatOptions

    constructor(
        steps: readonly Step[] = [],
        sessions: Iterable<Session> = [],
        options: { renderedSteps?: boolean; introducedSessions?: boolean; includeToolIo?: boolean } = {}
    ) {
        this.sessionFormatOptions = { includeToolIo: options.includeToolIo }
        for (const step of steps) {
            this.registerStep(step)
            if (options.renderedSteps === true) this.renderedSteps.set(step.id, stepActivityFingerprint(step))
        }
        for (const session of sessions) {
            this.sessions.set(session.id, session)
            if (options.introducedSessions === true) this.introducedSessions.add(session.id)
        }
    }

    registerSession(session: Session): void {
        this.sessions.set(session.id, session)
    }

    formatStep(step: Step): string {
        this.registerStep(step)
        const fingerprint = stepActivityFingerprint(step)
        if (this.renderedSteps.get(step.id) === fingerprint) return ""
        this.renderedSteps.set(step.id, fingerprint)

        const lines: string[] = []
        this.openOwner(lines, step.id, stepActivityTimestamp(step), `${stepNumber(step)}. ${step.key}`)
        lines.push(...stepActivityDetails(step).map((line) => nestedLine(line, 2)))
        this.lastDetail = "other"
        return `${lines.join("\n")}\n`
    }

    formatSessionMessage(message: SessionMessage): string {
        const step = this.stepsBySession.get(message.sessionId)
        if (step === undefined) return formatSessionMessage(message, this.sessionFormatOptions)

        const messageLines = formatAlignedSessionMessage(message, this.sessionFormatOptions)
        if (messageLines.length === 0) return ""

        const lines: string[] = []
        this.openOwner(lines, step.id, message.createdAt, `${stepNumber(step)}. ${step.key}`)
        const session = this.sessions.get(message.sessionId)
        if (!this.introducedSessions.has(message.sessionId)) {
            const details =
                session === undefined
                    ? `Session ${message.sessionId}`
                    : `Session ${session.id} · ${session.client} · ${session.provider}/${session.model}`
            lines.push(nestedLine(details, 2))
            this.introducedSessions.add(message.sessionId)
        } else if (this.lastDetail !== "session") {
            lines.push(nestedLine("Session (continued)", 2))
        }
        lines.push(...messageLines.map((line) => nestedLine(line, 3)))
        this.lastDetail = "session"
        return `${lines.join("\n")}\n`
    }

    formatRun(response: GetRunResponse): string {
        const run = response.run
        const metadata = run?.metadata
        if (run === undefined || metadata === undefined) return ""

        const lines: string[] = []
        this.openOwner(lines, `run:${metadata.id}`, metadata.endedAt ?? metadata.startedAt, `Run ${metadata.id}`)
        lines.push(nestedLine(formatActivityExecution(metadata.status, metadata.startedAt, metadata.endedAt), 2))
        if (run.error !== undefined) lines.push(nestedLine(`Error ${run.error}`, 2))
        if (run.outputJson !== undefined) lines.push(nestedLine(`Output ${compactJson(run.outputJson)}`, 2))
        this.lastDetail = "other"
        return `${lines.join("\n")}\n`
    }

    private registerStep(step: Step): void {
        if (step.sessionId !== undefined) this.stepsBySession.set(step.sessionId, step)
    }

    private openOwner(lines: string[], owner: string, occurredAt: RunMetadata["startedAt"], label: string): void {
        if (this.currentOwner === owner) return
        if (this.activityStarted) lines.push("")
        lines.push(indent(`${activityTimestamp(occurredAt)}  ${label}`))
        this.currentOwner = owner
        this.activityStarted = true
        this.lastDetail = "other"
    }
}

function formatRunHeader(metadata: RunMetadata, now: Date, activeSteps?: number): string[] {
    const execution = formatExecution(metadata.status, metadata.startedAt, metadata.endedAt, now)
    const active =
        metadata.status === ExecutionStatus.RUNNING && activeSteps !== undefined && activeSteps > 0
            ? ` · ${activeSteps} active ${activeSteps === 1 ? "step" : "steps"}`
            : ""
    return [
        `Run ${metadata.id}`,
        indent(`${metadata.workflowName} · ${metadata.key} · attempt ${metadata.attempt}`),
        indent(`${execution}${active}`)
    ]
}

function stepActivityFingerprint(step: Step): string {
    return stepActivityDetails(step).join("\n")
}

function stepActivityDetails(step: Step): string[] {
    const lines = [`${stepKind(step.kind)} · ${formatActivityExecution(step.status, step.startedAt, step.endedAt)}`]
    if (step.error !== undefined) lines.push(`Error ${step.error}`)
    if (step.outputJson !== undefined) lines.push(`Output ${compactJson(step.outputJson)}`)
    return lines
}

function stepActivityTimestamp(step: Step): Step["startedAt"] {
    return step.status === ExecutionStatus.RUNNING ? step.startedAt : (step.endedAt ?? step.startedAt)
}

function stepNumber(step: Step): number {
    return step.seq + 1
}

function formatActivityExecution(
    status: ExecutionStatus,
    startedAt: RunMetadata["startedAt"],
    endedAt: RunMetadata["endedAt"]
): string {
    const timing = status === ExecutionStatus.RUNNING ? undefined : executionTiming(startedAt, endedAt)
    return timing === undefined ? executionStatus(status) : `${executionStatus(status)} · ${timing}`
}

function activityTimestamp(value: RunMetadata["startedAt"]): string {
    if (value === undefined) return "-"
    const date = timestampDate(value)
    return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`
}

function compactJson(value: string): string {
    try {
        return JSON.stringify(JSON.parse(value))
    } catch {
        return value.replaceAll("\n", " ")
    }
}

function twoDigits(value: number): string {
    return String(value).padStart(2, "0")
}

function stepKind(value: StepKind): string {
    switch (value) {
        case StepKind.CUSTOM:
            return "custom"
        case StepKind.ARTIFACT:
            return "artifact"
        case StepKind.LLM:
            return "llm"
        case StepKind.AGENT:
            return "coding-agent"
        case StepKind.EVENT:
            return "event"
        case StepKind.WORKTREE:
            return "worktree"
        default:
            return "unspecified"
    }
}
