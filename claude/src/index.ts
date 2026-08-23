import { query } from "@anthropic-ai/claude-agent-sdk"
import type {
    Options,
    SDKAssistantMessage,
    SDKMessage,
    SDKResultMessage,
    SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk"
import { BaseCodingAgent, type CodingAgentInvocation } from "@clankhouse/core/ai/base-agent"
import { type CommonTool, type SessionRecorder, type ToolSource } from "@clankhouse/core/ai/sessions"
import type { Worktree } from "@clankhouse/core/git"

export type QueryFunction = (input: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: Options
}) => AsyncIterable<SDKMessage>

export type ClaudeAgentOptions = {
    model: string
    effort?: Options["effort"]
    maxTurns?: number
    env?: Record<string, string | undefined>
    allowedTools?: string[]
    disallowedTools?: string[]
    /**
     * Sources the agent loads configuration from. Caution: the default is `["project"]`, which is
     * required to pick up the target repo's CLAUDE.md but also loads that repo's committed
     * `.claude/settings.json`, applying its permissions and hooks during the run. Pass `[]` to run
     * against a repo without trusting its committed settings.
     */
    settingSources?: Options["settingSources"]
    systemPrompt?: Options["systemPrompt"]
    query?: QueryFunction
}

export class ClaudeAgent extends BaseCodingAgent {
    readonly client = "claude"
    readonly provider = "anthropic"
    readonly model: string
    private readonly options: ClaudeAgentOptions
    private readonly queryFn: QueryFunction

    constructor(options: ClaudeAgentOptions) {
        super()
        this.model = options.model
        this.options = options
        this.queryFn = options.query ?? query
    }

    protected async invoke(invocation: CodingAgentInvocation): Promise<unknown> {
        return this.invokeWithInstructedOutput(invocation, async (prompt) => {
            let result: SDKResultMessage | undefined
            const assistantMessages: string[] = []
            for await (const message of this.queryFn({
                prompt,
                options: this.buildOptions(invocation.worktree)
            })) {
                record(invocation.session, message)
                const text = assistantText(message)
                if (text !== undefined) assistantMessages.push(text)
                if (message.type === "result") result = message
            }
            if (result === undefined) throw new Error("Claude agent stream ended without a result")
            if (result.subtype !== "success") {
                const details = result.errors.length > 0 ? `: ${result.errors.join("; ")}` : ""
                throw new Error(`Claude agent failed with ${result.subtype}${details}`)
            }
            return assistantMessages
        })
    }

    private buildOptions(worktree: Worktree): Options {
        const options: Options = {
            cwd: worktree.path,
            model: this.model,
            permissionMode: "auto",
            systemPrompt: this.options.systemPrompt ?? { type: "preset", preset: "claude_code" },
            settingSources: this.options.settingSources ?? ["project"],
            disallowedTools: [...new Set([...(this.options.disallowedTools ?? []), "AskUserQuestion"])]
        }
        if (this.options.effort !== undefined) options.effort = this.options.effort
        if (this.options.maxTurns !== undefined) options.maxTurns = this.options.maxTurns
        if (this.options.env !== undefined) options.env = { ...process.env, ...this.options.env }
        if (this.options.allowedTools !== undefined) options.allowedTools = this.options.allowedTools
        return options
    }
}

function assistantText(message: SDKMessage): string | undefined {
    if (message.type !== "assistant") return undefined
    const blocks = message.message.content.filter((block) => block.type === "text")
    return blocks.length === 0 ? undefined : blocks.map((block) => block.text).join("")
}

function record(session: SessionRecorder, message: SDKMessage): void {
    if (message.type === "system" && message.subtype === "init") {
        session.addMessage("system", JSON.stringify({ sessionId: message.session_id, model: message.model }))
    } else if (message.type === "assistant") {
        for (const block of message.message.content) recordAssistantBlock(session, block)
    } else if (message.type === "user" && typeof message.message.content !== "string") {
        for (const block of message.message.content) {
            if (block.type === "tool_result") {
                const failed = block.is_error === true
                const error = failed ? toolResultError(block) : undefined
                session.addToolResult({
                    toolCallId: block.tool_use_id,
                    status: failed ? "failed" : "succeeded",
                    output: block,
                    ...(error !== undefined ? { error } : {})
                })
            }
        }
    }
}

type AssistantBlock = SDKAssistantMessage["message"]["content"][number]

function recordAssistantBlock(session: SessionRecorder, block: AssistantBlock): void {
    if (block.type === "text") {
        session.addMessage("assistant", block.text)
    } else if (block.type === "thinking" && block.thinking.length > 0) {
        session.addMessage("reasoning", block.thinking)
    } else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
        const identity = claudeToolIdentity(block)
        const common = claudeCommonTool(block.type, block.name, block.input)
        session.addToolCall({
            id: block.id,
            name: identity.name,
            source: identity.source,
            input: block.input,
            ...(common !== undefined ? { common } : {})
        })
    } else if (isToolResultBlock(block)) {
        const failed = toolResultFailed(block)
        const error = failed ? toolResultError(block) : undefined
        session.addToolResult({
            toolCallId: block.tool_use_id,
            status: failed ? "failed" : "succeeded",
            output: block,
            ...(error !== undefined ? { error } : {})
        })
    }
}

type ClaudeToolBlock = Extract<AssistantBlock, { type: "tool_use" | "server_tool_use" | "mcp_tool_use" }>

function claudeToolIdentity(block: ClaudeToolBlock): { name: string; source: ToolSource } {
    if (block.type === "mcp_tool_use") {
        return { name: block.name, source: { kind: "mcp", server: block.server_name } }
    }
    if (block.type === "server_tool_use") return { name: block.name, source: { kind: "provider" } }
    return claudeMcpTool(block.name) ?? { name: block.name, source: { kind: "native" } }
}

function claudeMcpTool(name: string): { name: string; source: ToolSource } | undefined {
    const prefix = "mcp__"
    if (!name.startsWith(prefix)) return undefined
    const separator = name.indexOf("__", prefix.length)
    if (separator === prefix.length || separator === -1 || separator + 2 === name.length) return undefined
    return {
        name: name.slice(separator + 2),
        source: { kind: "mcp", server: name.slice(prefix.length, separator) }
    }
}

function claudeCommonTool(type: AssistantBlock["type"], name: string, input: unknown): CommonTool | undefined {
    if (type === "server_tool_use") return name === "web_search" ? webSearchTool(input) : undefined
    if (type !== "tool_use") return undefined
    switch (name) {
        case "Read": {
            const path = inputString(input, "file_path")
            return path === undefined ? undefined : { name: "file.read", path }
        }
        case "Write":
        case "Edit": {
            const path = inputString(input, "file_path")
            return path === undefined ? undefined : { name: "file.change", paths: [path] }
        }
        case "Bash": {
            const command = inputString(input, "command")
            return command === undefined ? undefined : { name: "shell.execute", command }
        }
        case "Glob":
        case "Grep": {
            const pattern = inputString(input, "pattern")
            if (pattern === undefined) return undefined
            const path = inputString(input, "path")
            return {
                name: "file.search",
                pattern,
                ...(path !== undefined ? { path } : {})
            }
        }
        case "WebSearch":
            return webSearchTool(input)
        default:
            return undefined
    }
}

function webSearchTool(input: unknown): CommonTool | undefined {
    const query = inputString(input, "query")
    return query === undefined ? undefined : { name: "web.search", query }
}

function inputString(input: unknown, key: string): string | undefined {
    if (typeof input !== "object" || input === null || !(key in input)) return undefined
    const value = (input as Record<string, unknown>)[key]
    return typeof value === "string" && value.length > 0 ? value : undefined
}

function isToolResultBlock(block: AssistantBlock): block is AssistantBlock & { tool_use_id: string; content: unknown } {
    return "tool_use_id" in block && typeof block.tool_use_id === "string" && block.type.endsWith("_tool_result")
}

function toolResultFailed(block: { content: unknown }): boolean {
    if ("is_error" in block && block.is_error === true) return true
    const content = block.content
    return (
        typeof content === "object" &&
        content !== null &&
        "type" in content &&
        typeof content.type === "string" &&
        content.type.includes("error")
    )
}

function toolResultError(block: { content?: unknown }): string | undefined {
    if (typeof block.content === "string") return block.content
    if (Array.isArray(block.content)) {
        const text = block.content
            .filter(
                (content): content is { type: "text"; text: string } =>
                    typeof content === "object" &&
                    content !== null &&
                    "type" in content &&
                    content.type === "text" &&
                    "text" in content &&
                    typeof content.text === "string"
            )
            .map((content) => content.text)
            .join("\n")
        return text.length > 0 ? text : undefined
    }
    if (typeof block.content !== "object" || block.content === null) return undefined
    if ("error_code" in block.content && typeof block.content.error_code === "string") return block.content.error_code
    return undefined
}
