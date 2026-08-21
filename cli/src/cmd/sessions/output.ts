import {
    SessionKind,
    SessionRole,
    ToolResultStatus,
    ToolSourceKind,
    type GetSessionResponse,
    type Session,
    type SessionMessage,
    type SessionToolCall
} from "@loopy/server/proto"
import { executionStatus, executionTiming, indent } from "../../output"

export type SessionFormatOptions = {
    includeToolIo?: boolean
}

type FormattedSessionMessage = {
    role: string
    content: string
}

export function formatSession(response: GetSessionResponse, options: SessionFormatOptions = {}): string {
    if (response.session === undefined) return "Session response is empty.\n"
    return formatSessionValue(response.session, options)
}

export function formatSessionValue(session: Session, options: SessionFormatOptions = {}): string {
    const lines = [...formatSessionHeader(session, new Date()), "", "Messages"]
    const messages = session.messages.flatMap((message) => formatAlignedSessionMessage(message, options))
    if (messages.length === 0) lines.push(indent("None"))
    else lines.push(...messages.map((line) => nestedLine(line)))
    return `${lines.join("\n")}\n`
}

export function formatSessionWatchHeader(response: GetSessionResponse): string {
    if (response.session === undefined) return "Session response is empty.\n"
    return `${formatSessionHeader(response.session, new Date()).join("\n")}\n\nMessages\n`
}

export function formatSessionMessageLines(message: SessionMessage, options: SessionFormatOptions = {}): string {
    const lines = formatAlignedSessionMessage(message, options)
    if (lines.length === 0) return ""
    return `${lines.map((line) => nestedLine(line)).join("\n")}\n`
}

export function formatAlignedSessionMessage(message: SessionMessage, options: SessionFormatOptions = {}): string[] {
    return formattedSessionMessages(message, options).flatMap(({ role: rawRole, content: rawContent }) => {
        const role = rawRole === "tool_result" ? "result" : rawRole
        const content = rawContent.trimEnd()
        const prefix = role.padEnd(11)
        return content
            .split("\n")
            .map((line, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`.trimEnd())
    })
}

export function formatSessionMessage(message: SessionMessage, options: SessionFormatOptions = {}): string {
    return formattedSessionMessages(message, options)
        .map(({ role, content }) => `${role}: ${content}\n`)
        .join("")
}

function formattedSessionMessages(message: SessionMessage, options: SessionFormatOptions): FormattedSessionMessage[] {
    switch (message.payload.case) {
        case "message":
            return [{ role: sessionRole(message.payload.value.role), content: message.payload.value.content }]
        case "toolCall": {
            const call = message.payload.value
            const messages = [{ role: "tool", content: compactToolCall(call) }]
            if (options.includeToolIo === true) {
                messages.push({
                    role: "input",
                    content: JSON.stringify({
                        id: call.id,
                        tool: qualifiedToolName(call),
                        input: JSON.parse(call.inputJson)
                    })
                })
            }
            return messages
        }
        case "toolResult": {
            const result = message.payload.value
            if (options.includeToolIo === true) {
                const content = result.outputJson === undefined ? null : JSON.parse(result.outputJson)
                return [
                    {
                        role: "tool_result",
                        content: JSON.stringify({
                            toolUseId: result.toolCallId,
                            status: toolResultStatus(result.status),
                            content,
                            ...(result.error !== undefined ? { error: result.error } : {})
                        })
                    }
                ]
            }
            if (result.status === ToolResultStatus.SUCCEEDED && result.error === undefined) return []
            const status = result.status === ToolResultStatus.SUCCEEDED ? "failed" : toolResultStatus(result.status)
            const summary = result.error === undefined ? status : `${status}: ${result.error}`
            return [{ role: "tool_result", content: compactSummary(summary) }]
        }
        default:
            return [{ role: "unspecified", content: "" }]
    }
}

function compactToolCall(call: SessionToolCall): string {
    let summary: string
    switch (call.common.case) {
        case "fileRead":
            summary = withArgument("read", call.common.value.path)
            break
        case "fileChange":
            summary = withArgument("change", call.common.value.paths.join(", "))
            break
        case "shellExecute":
            summary = withArgument("shell", call.common.value.command)
            break
        case "fileSearch": {
            const { pattern, path } = call.common.value
            summary =
                pattern === undefined
                    ? path === undefined
                        ? "search"
                        : `search in ${path}`
                    : path === undefined
                      ? `search ${pattern}`
                      : `search ${pattern} in ${path}`
            break
        }
        case "webSearch":
            summary = withArgument("web_search", call.common.value.query)
            break
        default:
            summary = `${qualifiedToolName(call)}${toolSourceSuffix(call.source?.kind)}`
    }
    return compactSummary(summary)
}

function qualifiedToolName(call: SessionToolCall): string {
    return call.source?.kind === ToolSourceKind.MCP && call.source.server !== undefined
        ? `${call.source.server}.${call.name}`
        : call.name
}

function withArgument(operation: string, value: string): string {
    return value.length === 0 ? operation : `${operation} ${value}`
}

function toolSourceSuffix(kind: ToolSourceKind | undefined): string {
    switch (kind) {
        case ToolSourceKind.MCP:
            return " (mcp)"
        case ToolSourceKind.PROVIDER:
            return " (provider)"
        default:
            return ""
    }
}

function compactSummary(value: string): string {
    const escapedCharacters = [...value].map((character) => {
        const codePoint = character.codePointAt(0)!
        return codePoint <= 31 || codePoint === 127 ? JSON.stringify(character).slice(1, -1) : character
    })
    const escapedLength = escapedCharacters.reduce((length, character) => length + [...character].length, 0)
    if (escapedLength <= 160) return escapedCharacters.join("")

    const summary: string[] = []
    let summaryLength = 0
    for (const character of escapedCharacters) {
        const characterLength = [...character].length
        if (summaryLength + characterLength > 159) break
        summary.push(character)
        summaryLength += characterLength
    }
    return `${summary.join("")}…`
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
