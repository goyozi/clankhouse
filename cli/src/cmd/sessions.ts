import {
    GetSessionResponseSchema,
    SessionKind,
    SessionRole,
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
        .option("--after-message <message-id>", "start after a message")
        .action(async (sessionId: string, options: { afterMessage?: string }, command: Command) => {
            const client = await runtime.client(command)
            const output = runtime.output(command)
            for await (const response of client.watchSession(
                {
                    sessionId,
                    ...(options.afterMessage !== undefined ? { afterMessageId: options.afterMessage } : {})
                },
                { signal: runtime.signal }
            )) {
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
    return `${sessionRole(message.role)}: ${message.content}\n`
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
        case SessionRole.TOOL:
            return "tool"
        case SessionRole.TOOL_RESULT:
            return "tool_result"
        default:
            return "unspecified"
    }
}
