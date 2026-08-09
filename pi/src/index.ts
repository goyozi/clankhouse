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
import type { SessionRecorder } from "@loopy/core/ai/sessions"
import type { Worktree } from "@loopy/core/git"

export type PiAgentSessionOptions = Omit<CreateAgentSessionOptions, "cwd" | "model" | "sessionManager">

export type PiAgentSession = Pick<AgentSession, "sessionId" | "subscribe" | "prompt" | "dispose">

export type PiAgentSessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: PiAgentSession }>

export type PiAgentOptions = {
    modelProvider: string
    model: string
    sessionOptions?: PiAgentSessionOptions
    createAgentSession?: PiAgentSessionFactory
}

export class PiAgent extends BaseCodingAgent {
    readonly provider = "pi"
    readonly model: string
    private readonly options: PiAgentOptions
    private readonly createAgentSessionFn: PiAgentSessionFactory
    private modelRuntimePromise: Promise<ModelRuntime> | undefined

    constructor(options: PiAgentOptions) {
        super()
        this.model = `${options.modelProvider}/${options.model}`
        this.options = options
        this.createAgentSessionFn = options.createAgentSession ?? createAgentSession
    }

    protected async invoke(invocation: CodingAgentInvocation): Promise<unknown> {
        return this.invokeWithInstructedOutput(invocation, async (prompt) => {
            const modelRuntime = await this.getModelRuntime()
            const model = modelRuntime.getModel(this.options.modelProvider, this.options.model)
            if (model === undefined) throw new Error(`Pi model not found: ${this.model}`)

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
                session.addMessage("tool", JSON.stringify({ id: block.id, tool: block.name, input: block.arguments }))
            }
        }
    } else if (message.role === "toolResult") {
        session.addMessage("tool_result", JSON.stringify({ toolUseId: message.toolCallId, content: message }))
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
