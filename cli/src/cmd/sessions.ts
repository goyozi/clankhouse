import {
    GetSessionResponseSchema,
    SessionKind,
    SessionRole,
    ToolResultStatus,
    ToolSourceKind,
    WatchSessionResponseSchema,
    type GetSessionResponse,
    type Session,
    type SessionMessage
} from "@loopy/server/proto"
import type { Command } from "commander"
import { executionStatus, indent, timestamp } from "../output"
import type { Runtime } from "../runtime"

export function registerSessions(program: Command, runtime: Runtime): void {
    const sessions = program.command("sessions").description("Inspect AI sessions")
    sessions
        .command("get")
        .description("Get an AI session")
        .argument("<session-id>")
        .action(async (sessionId: string, _options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.getSession({ sessionId }, { signal: runtime.signal })
            await runtime.emit(command, GetSessionResponseSchema, response, () => formatSession(response))
        })
    sessions
        .command("watch")
        .description("Watch AI session messages")
        .argument("<session-id>")
        .action(async (sessionId: string, _options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const output = runtime.output(command)
            for await (const response of client.watchSession({ sessionId }, { signal: runtime.signal })) {
                if (output.json) await output.proto(WatchSessionResponseSchema, response)
                else if (response.message !== undefined) await output.write(formatSessionMessage(response.message))
            }
        })
}

function formatSession(response: GetSessionResponse): string {
    if (response.session === undefined) return "Session response is empty.\n"
    return formatSessionValue(response.session)
}

export function formatSessionValue(session: Session): string {
    const lines = [
        `Session: ${session.id}`,
        `Kind: ${sessionKind(session.kind)}`,
        `Provider: ${session.provider}`,
        `Model: ${session.model}`,
        `Status: ${executionStatus(session.status)}`,
        `Started: ${timestamp(session.startedAt)}`,
        `Ended: ${timestamp(session.endedAt)}`,
        "Messages:"
    ]
    if (session.messages.length === 0) lines.push("  None")
    else for (const message of session.messages) lines.push(indent(formatSessionMessage(message).trimEnd()))
    return `${lines.join("\n")}\n`
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
