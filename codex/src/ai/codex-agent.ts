import * as z from "zod"
import { Codex } from "@openai/codex-sdk"
import type { CodexOptions, RunStreamedResult, Thread, ThreadItem, ThreadOptions } from "@openai/codex-sdk"
import { BaseCodingAgent, type CodingAgentInvocation } from "@loopy/core/ai/base-agent"
import type { SessionRecorder } from "@loopy/core/ai/sessions"
import type { Worktree } from "@loopy/core/git"

type CodexThread = Pick<Thread, "runStreamed">

type CodexClient = {
    startThread(options?: ThreadOptions): CodexThread
}

export type CodexFactory = (options: CodexOptions) => CodexClient

export type CodexAgentOptions = {
    model: string
    sandboxMode?: ThreadOptions["sandboxMode"]
    approvalPolicy?: ThreadOptions["approvalPolicy"]
    modelReasoningEffort?: ThreadOptions["modelReasoningEffort"]
    networkAccessEnabled?: ThreadOptions["networkAccessEnabled"]
    webSearchMode?: ThreadOptions["webSearchMode"]
    additionalDirectories?: ThreadOptions["additionalDirectories"]
    codexPathOverride?: CodexOptions["codexPathOverride"]
    baseUrl?: CodexOptions["baseUrl"]
    apiKey?: CodexOptions["apiKey"]
    config?: CodexOptions["config"]
    env?: CodexOptions["env"]
    codexFactory?: CodexFactory
}

export class CodexAgent extends BaseCodingAgent {
    readonly provider = "codex"
    readonly model: string
    private readonly options: CodexAgentOptions
    private readonly codex: CodexClient

    constructor(options: CodexAgentOptions) {
        super()
        this.model = options.model
        this.options = options
        const codexFactory = options.codexFactory ?? ((clientOptions) => new Codex(clientOptions))
        this.codex = codexFactory(this.buildClientOptions())
    }

    protected async invoke({ prompt, output, worktree, session }: CodingAgentInvocation): Promise<unknown> {
        session.addMessage("user", prompt)
        const outputSchema = toJSONSchema(output)
        const thread = this.codex.startThread(this.buildThreadOptions(worktree))
        const { events } = await thread.runStreamed(prompt, { outputSchema })
        return consumeEvents(events, session, this.model)
    }

    private buildClientOptions(): CodexOptions {
        const options: CodexOptions = {}
        if (this.options.codexPathOverride !== undefined) options.codexPathOverride = this.options.codexPathOverride
        if (this.options.baseUrl !== undefined) options.baseUrl = this.options.baseUrl
        if (this.options.apiKey !== undefined) options.apiKey = this.options.apiKey
        if (this.options.config !== undefined) options.config = this.options.config
        if (this.options.env !== undefined) {
            options.env = { ...process.env, ...this.options.env } as Record<string, string>
        }
        return options
    }

    private buildThreadOptions(worktree: Worktree): ThreadOptions {
        const options: ThreadOptions = {
            model: this.model,
            workingDirectory: worktree.path,
            sandboxMode: this.options.sandboxMode ?? "workspace-write",
            approvalPolicy: this.options.approvalPolicy ?? "never"
        }
        if (this.options.modelReasoningEffort !== undefined) {
            options.modelReasoningEffort = this.options.modelReasoningEffort
        }
        if (this.options.networkAccessEnabled !== undefined) {
            options.networkAccessEnabled = this.options.networkAccessEnabled
        }
        if (this.options.webSearchMode !== undefined) options.webSearchMode = this.options.webSearchMode
        if (this.options.additionalDirectories !== undefined) {
            options.additionalDirectories = this.options.additionalDirectories
        }
        return options
    }
}

function toJSONSchema(output: z.ZodTypeAny): Record<string, unknown> {
    const schema = z.toJSONSchema(output)
    delete schema.$schema
    return schema
}

async function consumeEvents(
    events: RunStreamedResult["events"],
    session: SessionRecorder,
    model: string
): Promise<unknown> {
    let completed = false
    let finalResponse: string | undefined
    for await (const event of events) {
        if (event.type === "thread.started") {
            session.addMessage("system", JSON.stringify({ threadId: event.thread_id, model }))
        } else if (event.type === "item.started") {
            recordItemStarted(session, event.item)
        } else if (event.type === "item.completed") {
            recordItemCompleted(session, event.item)
            if (event.item.type === "agent_message") finalResponse = event.item.text
        } else if (event.type === "turn.completed") {
            completed = true
        } else if (event.type === "turn.failed") {
            throw new Error(`Codex agent failed: ${event.error.message}`)
        } else if (event.type === "error") {
            throw new Error(`Codex agent stream error: ${event.message}`)
        }
    }
    if (!completed) throw new Error("Codex agent stream ended without completing the turn")
    if (finalResponse === undefined || finalResponse.trim().length === 0) {
        throw new Error("Codex agent returned no final response")
    }
    try {
        return JSON.parse(finalResponse)
    } catch (error) {
        throw new Error("Codex agent returned invalid structured output", { cause: error })
    }
}

function recordItemStarted(session: SessionRecorder, item: ThreadItem): void {
    if (item.type === "command_execution") {
        recordTool(session, item.id, "command_execution", { command: item.command })
    } else if (item.type === "mcp_tool_call") {
        recordTool(session, item.id, `${item.server}.${item.tool}`, item.arguments)
    } else if (item.type === "web_search") {
        recordTool(session, item.id, "web_search", { query: item.query })
    }
}

function recordItemCompleted(session: SessionRecorder, item: ThreadItem): void {
    if (item.type === "agent_message" || item.type === "reasoning") {
        session.addMessage("assistant", item.text)
    } else if (item.type === "todo_list") {
        session.addMessage("assistant", JSON.stringify({ todoList: item.items }))
    } else {
        if (item.type === "file_change") recordTool(session, item.id, "file_change", { changes: item.changes })
        session.addMessage("tool_result", JSON.stringify({ toolUseId: item.id, content: item }))
    }
}

function recordTool(session: SessionRecorder, id: string, tool: string, input: unknown): void {
    session.addMessage("tool", JSON.stringify({ id, tool, input }))
}
