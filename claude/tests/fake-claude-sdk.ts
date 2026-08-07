import { randomUUID } from "node:crypto"
import type {
    NonNullableUsage,
    Options,
    SDKAssistantMessage,
    SDKMessage,
    SDKResultMessage,
    SDKSystemMessage,
    SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk"
import type { QueryFunction } from "@loopy/claude"
import { applyChange, type FakeChange } from "@loopy/core/ai/fake-agent"
import { taggedOutput } from "@loopy/test-utils"

type AssistantBlock = SDKAssistantMessage["message"]["content"][number]

export type FakeToolCall = {
    name: string
    input: Record<string, unknown>
    kind?: "tool_use" | "server_tool_use" | "mcp_tool_use"
    id?: string
    change?: FakeChange
    result?: string
}

export type FakeQueryScript = {
    thinking?: string[]
    text?: string[]
    toolCalls?: FakeToolCall[]
    output?: unknown
    finalResponse?: string
    errorSubtype?: Exclude<SDKResultMessage["subtype"], "success">
    errors?: string[]
    throwMidStream?: Error
    endWithoutResult?: boolean
}

export type FakeQueryCall = {
    prompt: string
    options: Options | undefined
}

export function fakeClaudeQuery(script: (prompt: string) => FakeQueryScript): {
    query: QueryFunction
    calls: FakeQueryCall[]
} {
    const calls: FakeQueryCall[] = []
    const query: QueryFunction = ({ prompt, options }) => {
        if (typeof prompt !== "string") throw new Error("fakeClaudeQuery supports only string prompts")
        calls.push({ prompt, options })
        return run(prompt, script(prompt), options)
    }
    return { query, calls }
}

async function* run(
    prompt: string,
    script: FakeQueryScript,
    options: Options | undefined
): AsyncGenerator<SDKMessage, void> {
    const sessionId = randomUUID()
    yield initMessage(sessionId, options)
    if (script.throwMidStream) throw script.throwMidStream
    for (const thinking of script.thinking ?? []) {
        yield assistantMessage(sessionId, options, [{ type: "thinking", thinking, signature: "fake-signature" }])
    }
    for (const text of script.text ?? []) {
        yield assistantMessage(sessionId, options, [{ type: "text", text, citations: null }])
    }
    for (const call of script.toolCalls ?? []) {
        const toolUseId = call.id ?? `toolu_${randomUUID()}`
        yield assistantMessage(sessionId, options, [toolUseBlock(call, toolUseId)])
        if (call.change) await applyChange(call.change, options?.cwd ?? process.cwd())
        yield toolResultMessage(sessionId, toolUseId, call.result ?? "ok")
    }
    let finalResponse = script.finalResponse
    if (script.output !== undefined) finalResponse ??= taggedOutput(prompt, JSON.stringify(script.output))
    if (finalResponse !== undefined) {
        yield assistantMessage(sessionId, options, [{ type: "text", text: finalResponse, citations: null }])
    }
    if (script.endWithoutResult) return
    yield resultMessage(sessionId, script, finalResponse)
}

function toolUseBlock(call: FakeToolCall, id: string): AssistantBlock {
    switch (call.kind ?? "tool_use") {
        case "server_tool_use":
            return { type: "server_tool_use", id, name: call.name as "web_search", input: call.input }
        case "mcp_tool_use":
            return { type: "mcp_tool_use", id, name: call.name, input: call.input, server_name: "fake-mcp" }
        default:
            return { type: "tool_use", id, name: call.name, input: call.input }
    }
}

function initMessage(sessionId: string, options: Options | undefined): SDKSystemMessage {
    return {
        type: "system",
        subtype: "init",
        apiKeySource: "user",
        claude_code_version: "0.0.0-fake",
        cwd: options?.cwd ?? process.cwd(),
        tools: ["Read", "Write", "Edit", "Bash"],
        mcp_servers: [],
        model: options?.model ?? "fake-model",
        permissionMode: options?.permissionMode ?? "default",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        uuid: randomUUID(),
        session_id: sessionId
    }
}

function assistantMessage(
    sessionId: string,
    options: Options | undefined,
    content: SDKAssistantMessage["message"]["content"]
): SDKAssistantMessage {
    return {
        type: "assistant",
        message: {
            id: `msg_${randomUUID()}`,
            container: null,
            content,
            context_management: null,
            diagnostics: null,
            model: options?.model ?? "fake-model",
            role: "assistant",
            stop_details: null,
            stop_reason: null,
            stop_sequence: null,
            type: "message",
            usage: fakeUsage()
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: sessionId
    }
}

function toolResultMessage(sessionId: string, toolUseId: string, result: string): SDKUserMessage {
    return {
        type: "user",
        message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }]
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: sessionId
    }
}

function resultMessage(sessionId: string, script: FakeQueryScript, finalResponse?: string): SDKResultMessage {
    const common = {
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: fakeUsage(),
        modelUsage: {},
        permission_denials: [],
        uuid: randomUUID(),
        session_id: sessionId
    }
    if (script.errorSubtype) {
        return {
            type: "result",
            subtype: script.errorSubtype,
            is_error: true,
            errors: script.errors ?? [],
            ...common
        }
    }
    return {
        type: "result",
        subtype: "success",
        is_error: false,
        result: finalResponse ?? "done",
        ...common
    }
}

function fakeUsage(): NonNullableUsage {
    return {
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        fallback_credit: { status: { type: "not_applied", reason: "not_enabled" } },
        inference_geo: "fake",
        input_tokens: 1,
        iterations: [],
        output_tokens: 1,
        output_tokens_details: { thinking_tokens: 0 },
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "standard",
        speed: "standard"
    }
}
