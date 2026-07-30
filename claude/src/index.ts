import { query } from "@anthropic-ai/claude-agent-sdk"
import type {
    Options,
    SDKAssistantMessage,
    SDKMessage,
    SDKResultMessage,
    SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk"
import { BaseCodingAgent, type CodingAgentInvocation } from "@loopy/core/ai/base-agent"
import type { SessionRecorder } from "@loopy/core/ai/sessions"
import type { Worktree } from "@loopy/core/git"

export type QueryFunction = (input: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: Options
}) => AsyncIterable<SDKMessage>

export type ClaudeAgentOptions = {
    model: string
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
    readonly provider = "claude"
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
            for await (const message of this.queryFn({
                prompt,
                options: this.buildOptions(invocation.worktree)
            })) {
                record(invocation.session, message)
                if (message.type === "result") result = message
            }
            if (result === undefined) throw new Error("Claude agent stream ended without a result")
            if (result.subtype !== "success") {
                const details = result.errors.length > 0 ? `: ${result.errors.join("; ")}` : ""
                throw new Error(`Claude agent failed with ${result.subtype}${details}`)
            }
            return result.result
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
        if (this.options.maxTurns !== undefined) options.maxTurns = this.options.maxTurns
        if (this.options.env !== undefined) options.env = { ...process.env, ...this.options.env }
        if (this.options.allowedTools !== undefined) options.allowedTools = this.options.allowedTools
        return options
    }
}

function record(session: SessionRecorder, message: SDKMessage): void {
    if (message.type === "system" && message.subtype === "init") {
        session.addMessage("system", JSON.stringify({ sessionId: message.session_id, model: message.model }))
    } else if (message.type === "assistant") {
        for (const block of message.message.content) recordAssistantBlock(session, block)
    } else if (message.type === "user" && typeof message.message.content !== "string") {
        for (const block of message.message.content) {
            if (block.type === "tool_result") {
                session.addMessage(
                    "tool_result",
                    JSON.stringify({ toolUseId: block.tool_use_id, content: block.content ?? null })
                )
            }
        }
    }
}

type AssistantBlock = SDKAssistantMessage["message"]["content"][number]

function recordAssistantBlock(session: SessionRecorder, block: AssistantBlock): void {
    if (block.type === "text") {
        session.addMessage("assistant", block.text)
    } else if (block.type === "thinking") {
        session.addMessage("reasoning", block.thinking)
    } else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
        session.addMessage("tool", JSON.stringify({ id: block.id, tool: block.name, input: block.input }))
    }
}
