import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
    createAgentSession,
    ModelRuntime,
    SessionManager,
    type AgentSession,
    type AgentSessionEvent,
    type CreateAgentSessionOptions
} from "@earendil-works/pi-coding-agent"
import { BaseCodingAgent, type CodingAgentInvocation } from "@loopy/core/ai/base-agent"
import type { CommonTool, SessionRecorder } from "@loopy/core/ai/sessions"
import type { Worktree } from "@loopy/core/git"

export type PiAgentSessionOptions = Omit<CreateAgentSessionOptions, "cwd" | "model" | "sessionManager">

export type PiAgentSession = Pick<AgentSession, "sessionId" | "subscribe" | "prompt" | "dispose">

export type PiAgentSessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: PiAgentSession }>

export type PiAgentOptions = {
    provider: string
    model: string
    sessionOptions?: PiAgentSessionOptions
    createAgentSession?: PiAgentSessionFactory
}

export class PiAgent extends BaseCodingAgent {
    readonly client = "pi"
    readonly provider: string
    readonly model: string
    private readonly options: PiAgentOptions
    private readonly createAgentSessionFn: PiAgentSessionFactory
    private modelRuntimePromise: Promise<ModelRuntime> | undefined

    constructor(options: PiAgentOptions) {
        super()
        this.provider = options.provider
        this.model = options.model
        this.options = options
        this.createAgentSessionFn = options.createAgentSession ?? createAgentSession
    }

    protected async invoke(invocation: CodingAgentInvocation): Promise<unknown> {
        return this.invokeWithInstructedOutput(invocation, async (prompt) => {
            const modelRuntime = await this.getModelRuntime()
            const model = modelRuntime.getModel(this.provider, this.model)
            if (model === undefined) {
                throw new Error(`Pi model not found: provider "${this.provider}", model "${this.model}"`)
            }

            const { session } = await this.createAgentSessionFn(
                this.buildSessionOptions(invocation.worktree, modelRuntime, model)
            )
            return runSession(session, invocation.session, model, prompt)
        })
    }

    private async getModelRuntime(): Promise<ModelRuntime> {
        if (this.options.sessionOptions?.modelRuntime !== undefined) {
            return this.options.sessionOptions.modelRuntime
        }
        this.modelRuntimePromise ??= ModelRuntime.create(modelRuntimeOptions(this.options.sessionOptions?.agentDir))
        try {
            return await this.modelRuntimePromise
        } catch (error) {
            this.modelRuntimePromise = undefined
            throw error
        }
    }

    private buildSessionOptions(
        worktree: Worktree,
        modelRuntime: ModelRuntime,
        model: NonNullable<ReturnType<ModelRuntime["getModel"]>>
    ): CreateAgentSessionOptions {
        const sessionOptions = this.options.sessionOptions ?? {}
        return {
            ...sessionOptions,
            cwd: worktree.path,
            model,
            modelRuntime,
            sessionManager: SessionManager.inMemory(worktree.path),
            excludeTools: [...new Set([...(sessionOptions.excludeTools ?? []), "ask_question"])]
        }
    }
}

type PiMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"]
type PiAssistantMessage = Extract<PiMessage, { role: "assistant" }>
type PiModel = NonNullable<CreateAgentSessionOptions["model"]>

async function runSession(
    session: PiAgentSession,
    recorder: SessionRecorder,
    model: PiModel,
    prompt: string
): Promise<string | undefined> {
    let lastAssistant: PiAssistantMessage | undefined
    let unsubscribe: (() => void) | undefined
    let succeeded = false
    try {
        recorder.addMessage(
            "system",
            JSON.stringify({ sessionId: session.sessionId, provider: model.provider, model: model.id })
        )
        unsubscribe = session.subscribe((event) => {
            if (event.type !== "message_end") return
            recordMessage(recorder, event.message)
            if (event.message.role === "assistant") lastAssistant = event.message
        })
        await session.prompt(prompt, { source: "rpc" })
        const finalMessage = collectFinalMessage(lastAssistant)
        succeeded = true
        return finalMessage
    } finally {
        cleanupSession(session, unsubscribe, !succeeded)
    }
}

function cleanupSession(session: PiAgentSession, unsubscribe: (() => void) | undefined, suppressErrors: boolean): void {
    const failures: unknown[] = []
    try {
        unsubscribe?.()
    } catch (error) {
        failures.push(error)
    }
    try {
        session.dispose()
    } catch (error) {
        failures.push(error)
    }
    if (!suppressErrors && failures.length > 0) throw failures[0]
}

function recordMessage(session: SessionRecorder, message: PiMessage): void {
    if (message.role === "assistant") {
        for (const block of message.content) {
            if (block.type === "text") {
                session.addMessage("assistant", block.text)
            } else if (block.type === "thinking") {
                session.addMessage("reasoning", block.thinking)
            } else if (block.type === "toolCall") {
                const common = piCommonTool(block.name, block.arguments)
                session.addToolCall({
                    id: block.id,
                    name: block.name,
                    source: { kind: "native" },
                    input: block.arguments,
                    ...(common !== undefined ? { common } : {})
                })
            }
        }
    } else if (message.role === "toolResult") {
        const error = message.isError
            ? message.content
                  .filter((content) => content.type === "text")
                  .map((content) => content.text)
                  .join("\n") || undefined
            : undefined
        session.addToolResult({
            toolCallId: message.toolCallId,
            status: message.isError ? "failed" : "succeeded",
            output: message,
            ...(error !== undefined ? { error } : {})
        })
    } else if (message.role === "custom") {
        session.addMessage(
            "user",
            JSON.stringify({
                customType: message.customType,
                content: message.content,
                display: message.display,
                details: message.details
            })
        )
    }
}

function piCommonTool(name: string, input: unknown): CommonTool | undefined {
    switch (name) {
        case "read": {
            const path = inputString(input, "path")
            return path === undefined ? undefined : { name: "file.read", path }
        }
        case "write":
        case "edit": {
            const path = inputString(input, "path")
            return path === undefined ? undefined : { name: "file.change", paths: [path] }
        }
        case "bash": {
            const command = inputString(input, "command")
            return command === undefined ? undefined : { name: "shell.execute", command }
        }
        case "grep":
        case "find": {
            const pattern = inputString(input, "pattern")
            if (pattern === undefined) return undefined
            const path = inputString(input, "path")
            return {
                name: "file.search",
                pattern,
                ...(path !== undefined ? { path } : {})
            }
        }
        case "ls": {
            const path = inputString(input, "path")
            return { name: "file.search", ...(path !== undefined ? { path } : {}) }
        }
        default:
            return undefined
    }
}

function inputString(input: unknown, key: string): string | undefined {
    if (typeof input !== "object" || input === null || !(key in input)) return undefined
    const value = (input as Record<string, unknown>)[key]
    return typeof value === "string" && value.length > 0 ? value : undefined
}

function collectFinalMessage(message: PiAssistantMessage | undefined): string | undefined {
    if (message === undefined) return undefined
    if (message.stopReason !== "stop") {
        const details = message.errorMessage === undefined ? "" : `: ${message.errorMessage}`
        throw new Error(`Pi agent stopped with ${message.stopReason}${details}`)
    }
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text)
    return text.length === 0 ? undefined : text.join("\n")
}

function modelRuntimeOptions(agentDir: string | undefined): Parameters<typeof ModelRuntime.create>[0] {
    if (agentDir === undefined) return undefined
    const resolvedAgentDir = resolveAgentDir(agentDir)
    return {
        authPath: join(resolvedAgentDir, "auth.json"),
        modelsPath: join(resolvedAgentDir, "models.json")
    }
}

function resolveAgentDir(agentDir: string): string {
    if (agentDir === "~") return homedir()
    if (agentDir.startsWith("~/")) return resolve(homedir(), agentDir.slice(2))
    return resolve(agentDir)
}
