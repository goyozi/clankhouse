import { randomUUID } from "node:crypto"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import type { AISessionMessage, SessionRecorder } from "@clankhouse/core/ai/sessions"
import { testRun } from "@clankhouse/testing"

export async function testSession(
    clankhouse: ClankHouse,
    options: Parameters<ClankHouse["sessions"]["create"]>[0]
): Promise<SessionRecorder> {
    let recorder!: SessionRecorder
    await testRun(
        clankhouse,
        async () => {
            recorder = clankhouse.sessions.create(options)
            return null
        },
        { key: `session-${randomUUID()}` }
    )
    return recorder
}

export function instructedTags(prompt: string): { name: string; opening: string; closing: string } {
    const match = prompt.match(/<(clankhouse_structured_output_[0-9a-f_]+)>/)
    if (match === null) throw new Error("prompt has no instructed output tags")
    return { name: match[1], opening: `<${match[1]}>`, closing: `</${match[1]}>` }
}

export function instructedSchema(prompt: string): unknown {
    const startMarker = "```json\n"
    const start = prompt.indexOf(startMarker)
    const end = prompt.indexOf("\n```", start + startMarker.length)
    if (start === -1 || end === -1) throw new Error("prompt has no instructed output schema")
    return JSON.parse(prompt.slice(start + startMarker.length, end))
}

export function taggedOutput(prompt: string, outputText: string): string {
    const { opening, closing } = instructedTags(prompt)
    return `${opening}\n${outputText}\n${closing}`
}

export function taggedStringOutput(prompt: string, outputText: string): string {
    const { opening, closing } = instructedTags(prompt)
    return `${opening}${outputText}${closing}`
}

export function sessionTextMessages(
    messages: AISessionMessage[]
): Array<Extract<AISessionMessage, { type: "message" }>> {
    return messages.filter(
        (message): message is Extract<AISessionMessage, { type: "message" }> => message.type === "message"
    )
}

export function sessionToolCallMessages(
    messages: AISessionMessage[]
): Array<Extract<AISessionMessage, { type: "tool_call" }>> {
    return messages.filter(
        (message): message is Extract<AISessionMessage, { type: "tool_call" }> => message.type === "tool_call"
    )
}
