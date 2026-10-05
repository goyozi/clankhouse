import type { CodexOptions, RunStreamedResult, Thread, ThreadItem, ThreadOptions } from "@openai/codex-sdk"
import { Codex } from "@openai/codex-sdk"
import { BaseCodingAgent, type CodingAgentInvocation } from "@clankhouse/core/ai/base-agent"
import type { SessionRecorder } from "@clankhouse/core/ai/sessions"
import type { Worktree } from "@clankhouse/core/git"

type CodexThread = Pick<Thread, "runStreamed">

type CodexClient = {
    startThread(options?: ThreadOptions): CodexThread
}

export type CodexFactory = (options: CodexOptions) => CodexClient

export type CodexAgentSdkOptions = {
    client?: CodexOptions
    thread?: Omit<ThreadOptions, "model" | "workingDirectory" | "modelReasoningEffort">
}

export type CodexAgentOptions = {
    model: string
    effort?: ThreadOptions["modelReasoningEffort"]
    sdkOptions?: CodexAgentSdkOptions
    codexFactory?: CodexFactory
}

export class CodexAgent extends BaseCodingAgent {
    readonly client = "codex"
    readonly provider = "openai"
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

    protected async invoke(invocation: CodingAgentInvocation): Promise<unknown> {
        return this.invokeWithInstructedOutput(invocation, async (prompt) => {
            const thread = this.codex.startThread(this.buildThreadOptions(invocation.worktree))
            const { events } = await thread.runStreamed(prompt)
            return consumeEvents(events, invocation.session, this.model)
        })
    }

    private buildClientOptions(): CodexOptions {
        const options: CodexOptions = { ...this.options.sdkOptions?.client }
        if (options.env !== undefined) {
            options.env = { ...process.env, ...options.env } as Record<string, string>
        }
        return options
    }

    private buildThreadOptions(worktree: Worktree): ThreadOptions {
        const options: ThreadOptions = {
            sandboxMode: "workspace-write",
            approvalPolicy: "never",
            ...this.options.sdkOptions?.thread,
            model: this.model,
            workingDirectory: worktree.path
        }
        if (this.options.effort !== undefined) options.modelReasoningEffort = this.options.effort
        return options
    }
}

async function consumeEvents(
    events: RunStreamedResult["events"],
    session: SessionRecorder,
    model: string
): Promise<string[]> {
    let completed = false
    const assistantMessages: string[] = []
    const recordedToolCalls = new Set<string>()
    for await (const event of events) {
        if (event.type === "thread.started") {
            session.addMessage("system", JSON.stringify({ threadId: event.thread_id, model }))
        } else if (event.type === "item.started") {
            if (isToolItem(event.item)) recordToolCall(session, event.item, recordedToolCalls)
        } else if (event.type === "item.completed") {
            recordItemCompleted(session, event.item, recordedToolCalls)
            if (event.item.type === "agent_message") assistantMessages.push(event.item.text)
        } else if (event.type === "turn.completed") {
            completed = true
        } else if (event.type === "turn.failed") {
            throw new Error(`Codex agent failed: ${event.error.message}`)
        } else if (event.type === "error") {
            throw new Error(`Codex agent stream error: ${event.message}`)
        }
    }
    if (!completed) throw new Error("Codex agent stream ended without completing the turn")
    return assistantMessages
}

function recordItemCompleted(session: SessionRecorder, item: ThreadItem, recordedToolCalls: Set<string>): void {
    if (item.type === "agent_message") {
        session.addMessage("assistant", item.text)
    } else if (item.type === "reasoning") {
        session.addMessage("reasoning", item.text)
    } else if (item.type === "todo_list") {
        session.addMessage("assistant", JSON.stringify({ todoList: item.items }))
    } else if (item.type === "error") {
        session.addMessage("system", JSON.stringify({ error: item.message }))
    } else if (isToolItem(item)) {
        recordToolCall(session, item, recordedToolCalls)
        const error = item.type === "mcp_tool_call" ? item.error?.message : undefined
        session.addToolResult({
            toolCallId: item.id,
            status: toolStatus(item),
            output: item,
            ...(error !== undefined ? { error } : {})
        })
    }
}

type CodexToolItem = Extract<ThreadItem, { type: "command_execution" | "file_change" | "mcp_tool_call" | "web_search" }>

function isToolItem(item: ThreadItem): item is CodexToolItem {
    return (
        item.type === "command_execution" ||
        item.type === "file_change" ||
        item.type === "mcp_tool_call" ||
        item.type === "web_search"
    )
}

function recordToolCall(session: SessionRecorder, item: CodexToolItem, recordedToolCalls: Set<string>): void {
    if (recordedToolCalls.has(item.id)) return
    recordedToolCalls.add(item.id)
    switch (item.type) {
        case "command_execution":
            session.addToolCall({
                id: item.id,
                name: item.type,
                source: { kind: "native" },
                input: { command: item.command },
                common: { name: "shell.execute", command: item.command }
            })
            break
        case "file_change": {
            const paths = item.changes.map((change) => change.path)
            session.addToolCall({
                id: item.id,
                name: item.type,
                source: { kind: "native" },
                input: { changes: item.changes },
                common: { name: "file.change", paths }
            })
            break
        }
        case "mcp_tool_call":
            session.addToolCall({
                id: item.id,
                name: item.tool,
                source: { kind: "mcp", server: item.server },
                input: item.arguments
            })
            break
        case "web_search":
            session.addToolCall({
                id: item.id,
                name: item.type,
                source: { kind: "provider" },
                input: { query: item.query },
                common: { name: "web.search", query: item.query }
            })
            break
    }
}

function toolStatus(item: CodexToolItem): "succeeded" | "failed" {
    if (item.type === "web_search") return "succeeded"
    return item.status === "failed" ? "failed" : "succeeded"
}
