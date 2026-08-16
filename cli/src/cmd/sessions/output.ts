import {
    SessionKind,
    SessionRole,
    ToolResultStatus,
    ToolSourceKind,
    type GetSessionResponse,
    type Session,
    type SessionMessage
} from "@loopy/server/proto"
import { executionStatus, executionTiming, indent } from "../../output"

export function formatSession(response: GetSessionResponse): string {
    if (response.session === undefined) return "Session response is empty.\n"
    return formatSessionValue(response.session)
}

export function formatSessionValue(session: Session): string {
    const lines = [...formatSessionHeader(session, new Date()), "", "Messages"]
    if (session.messages.length === 0) lines.push(indent("None"))
    else {
        for (const message of session.messages) {
            lines.push(...formatAlignedSessionMessage(message).map((line) => nestedLine(line)))
        }
    }
    return `${lines.join("\n")}\n`
}

export function formatSessionWatchHeader(response: GetSessionResponse): string {
    if (response.session === undefined) return "Session response is empty.\n"
    return `${formatSessionHeader(response.session, new Date()).join("\n")}\n\nMessages\n`
}

export function formatSessionMessageLines(message: SessionMessage): string {
    return `${formatAlignedSessionMessage(message)
        .map((line) => nestedLine(line))
        .join("\n")}\n`
}

export function formatAlignedSessionMessage(message: SessionMessage): string[] {
    const formatted = formatSessionMessage(message).trimEnd()
    const separator = formatted.indexOf(":")
    if (separator === -1) return formatted.split("\n")
    const rawRole = formatted.slice(0, separator)
    const role = rawRole === "tool_result" ? "result" : rawRole
    const rawContent = formatted.slice(separator + 1)
    const content = rawContent.startsWith(" ") ? rawContent.slice(1) : rawContent
    const prefix = role.padEnd(11)
    return content
        .split("\n")
        .map((line, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`.trimEnd())
}

export function formatSessionMessage(message: SessionMessage): string {
    switch (message.payload.case) {
        case "message":
            return `${sessionRole(message.payload.value.role)}: ${message.payload.value.content}\n`
        case "toolCall": {
            const call = message.payload.value
            const tool =
                call.source?.kind === ToolSourceKind.MCP && call.source.server !== undefined
                    ? `${call.source.server}.${call.name}`
                    : call.name
            return `tool: ${JSON.stringify({ id: call.id, tool, input: JSON.parse(call.inputJson) })}\n`
        }
        case "toolResult": {
            const result = message.payload.value
            const content = result.outputJson === undefined ? null : JSON.parse(result.outputJson)
            return `tool_result: ${JSON.stringify({
                toolUseId: result.toolCallId,
                status: toolResultStatus(result.status),
                content,
                ...(result.error !== undefined ? { error: result.error } : {})
            })}\n`
        }
        default:
            return "unspecified:\n"
    }
}

function formatSessionHeader(session: Session, now: Date): string[] {
    const timing = executionTiming(session.startedAt, session.endedAt, now)
    const execution =
        timing === undefined ? executionStatus(session.status) : `${executionStatus(session.status)} · ${timing}`
    return [
        `Session ${session.id}`,
        indent(`${sessionKind(session.kind)} · ${session.client} · ${session.provider}/${session.model}`),
        indent(execution)
    ]
}

function nestedLine(value: string): string {
    return value.length === 0 ? "" : indent(value)
}

function toolResultStatus(value: ToolResultStatus): string {
    switch (value) {
        case ToolResultStatus.SUCCEEDED:
            return "succeeded"
        case ToolResultStatus.FAILED:
            return "failed"
        default:
            return "unspecified"
    }
}

function sessionKind(value: SessionKind): string {
    switch (value) {
        case SessionKind.LLM:
            return "llm"
        case SessionKind.CODING_AGENT:
            return "coding-agent"
        default:
            return "unspecified"
    }
}

function sessionRole(value: SessionRole): string {
    switch (value) {
        case SessionRole.SYSTEM:
            return "system"
        case SessionRole.USER:
            return "user"
        case SessionRole.ASSISTANT:
            return "assistant"
        case SessionRole.REASONING:
            return "reasoning"
        default:
            return "unspecified"
    }
}
