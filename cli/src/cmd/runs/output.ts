import {
    ExecutionStatus,
    StepKind,
    type GetRunResponse,
    type ListRunsResponse,
    type RunMetadata,
    type Session,
    type SessionMessage,
    type Step,
    type WatchRunResponse,
    type WorkflowRun
} from "@loopy/server/proto"
import { executionStatus, executionTiming, indent, prettyJson, table, timestamp } from "../../output"
import { formatArtifactValue } from "../artifacts"
import { formatSessionMessage } from "../sessions"

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

export function formatRun(response: GetRunResponse, sessions: ReadonlyMap<string, Session> = new Map()): string {
    if (response.run === undefined) return "Run response is empty.\n"
    return formatWorkflowRun(response.run, sessions)
}

export function formatRunWatch(response: WatchRunResponse): string {
    if (response.item.case === "step") return formatStepUpdate(response.item.value)
    if (response.item.case === "run") return formatRunUpdate(response.item.value)
    return "Run update is empty.\n"
}

export function formatSessionWatch(message: SessionMessage): string {
    return formatSessionMessage(message)
}

export function formatSessionErrorPrefix(sessionId: string): string {
    return `session ${sessionId}: `
}

function formatWorkflowRun(run: WorkflowRun, sessions: ReadonlyMap<string, Session>): string {
    const metadata = run.metadata
    const now = new Date()
    const lines =
        metadata === undefined
            ? ["Run metadata is missing."]
            : [
                  `Run ${metadata.id}`,
                  indent(`${metadata.workflowName} · ${metadata.key} · attempt ${metadata.attempt}`),
                  indent(formatExecution(metadata.status, metadata.startedAt, metadata.endedAt, now))
              ]
    if (run.errorCode !== undefined) lines.push(indent(`Error code ${run.errorCode}`))
    if (run.error !== undefined) lines.push(indent(`Error ${run.error}`))
    lines.push("", "Steps")
    if (run.steps.length === 0) {
        lines.push("  None")
    } else {
        for (const [index, step] of run.steps.entries()) {
            if (index > 0) lines.push("")
            lines.push(...formatStep(step, sessions, now))
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

function formatStep(step: Step, sessions: ReadonlyMap<string, Session>, now: Date): string[] {
    const lines = [
        indent(`${step.seq}. ${step.key}`),
        nestedLine(`${stepKind(step.kind)} · ${formatExecution(step.status, step.startedAt, step.endedAt, now)}`, 2)
    ]
    if (step.sessionId !== undefined) {
        lines.push("")
        const session = sessions.get(step.sessionId)
        if (session === undefined) lines.push(nestedLine(`Session ${step.sessionId}`, 2))
        else lines.push(...formatIncludedSession(session))
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

function formatIncludedSession(session: Session): string[] {
    const lines = [
        nestedLine(`Session ${session.id}`, 2),
        nestedLine(`${session.client} · ${session.provider}/${session.model}`, 3),
        "",
        nestedLine("Messages", 3)
    ]
    if (session.messages.length === 0) lines.push(nestedLine("None", 4))
    else {
        for (const message of session.messages) {
            lines.push(...formatIncludedSessionMessage(message).map((value) => nestedLine(value, 4)))
        }
    }
    return lines
}

function formatIncludedSessionMessage(message: Session["messages"][number]): string[] {
    const formatted = formatSessionMessage(message).trimEnd()
    const separator = formatted.indexOf(":")
    if (separator === -1) return [formatted]
    const rawRole = formatted.slice(0, separator)
    const role = rawRole === "tool_result" ? "result" : rawRole
    const content = formatted
        .slice(separator + 1)
        .trimStart()
        .split("\n")
    const prefix = role.padEnd(11)
    return content.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`.trimEnd())
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

export function formatStepUpdate(step: Step): string {
    const suffix = step.error === undefined ? "" : `: ${step.error}`
    return `Step ${step.key} (${stepKind(step.kind)}): ${executionStatus(step.status)}${suffix}\n`
}

function formatRunUpdate(run: RunMetadata): string {
    return `Run ${run.id}: ${executionStatus(run.status)}\n`
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
