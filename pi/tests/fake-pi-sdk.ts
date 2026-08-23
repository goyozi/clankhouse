import { randomUUID } from "node:crypto"
import { join } from "node:path"
import {
    ModelRuntime,
    type AgentSessionEvent,
    type CreateAgentSessionOptions,
    type PromptOptions
} from "@earendil-works/pi-coding-agent"
import type { PiAgentSessionFactory } from "@clankhouse/pi"
import { applyChange, type FakeChange } from "@clankhouse/core/ai/fake-agent"
import { taggedOutput } from "@clankhouse/test-utils"

type PiMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"]
type PiAssistantMessage = Extract<PiMessage, { role: "assistant" }>
type PiAssistantContent = PiAssistantMessage["content"][number]
type PiToolResultMessage = Extract<PiMessage, { role: "toolResult" }>
type PiCustomMessage = Extract<PiMessage, { role: "custom" }>

export type FakePiToolCall = {
    id?: string
    name: string
    arguments: Record<string, unknown>
    change?: FakeChange
    result?: string
    isError?: boolean
}

export type FakePiScript = {
    thinking?: string[]
    text?: string[]
    toolCalls?: FakePiToolCall[]
    customMessages?: Array<Omit<PiCustomMessage, "role" | "timestamp">>
    output?: unknown
    finalResponse?: string
    finalTextBlocks?: string[]
    stopReason?: PiAssistantMessage["stopReason"]
    errorMessage?: string
    throwMidRun?: Error
    noFinalAssistant?: boolean
    disposeError?: Error
    unsubscribeError?: Error
}

export type FakePiSessionState = {
    disposed: boolean
    unsubscribed: boolean
}

export function fakePi(script: (prompt: string) => FakePiScript): {
    createAgentSession: PiAgentSessionFactory
    calls: CreateAgentSessionOptions[]
    prompts: string[]
    promptOptions: Array<PromptOptions | undefined>
    sessions: FakePiSessionState[]
} {
    const calls: CreateAgentSessionOptions[] = []
    const prompts: string[] = []
    const promptOptions: Array<PromptOptions | undefined> = []
    const sessions: FakePiSessionState[] = []
    const createAgentSession: PiAgentSessionFactory = async (options) => {
        calls.push(options)
        const listeners = new Set<(event: AgentSessionEvent) => void>()
        const state = { disposed: false, unsubscribed: false }
        sessions.push(state)
        let activeScript: FakePiScript | undefined
        const emit = (event: AgentSessionEvent) => {
            for (const listener of listeners) listener(event)
        }
        return {
            session: {
                sessionId: randomUUID(),
                subscribe(listener) {
                    listeners.add(listener)
                    return () => {
                        state.unsubscribed = true
                        listeners.delete(listener)
                        if (activeScript?.unsubscribeError !== undefined) throw activeScript.unsubscribeError
                    }
                },
                async prompt(prompt, promptOptionsValue) {
                    prompts.push(prompt)
                    promptOptions.push(promptOptionsValue)
                    activeScript = script(prompt)
                    await run(prompt, activeScript, options, emit)
                },
                dispose() {
                    state.disposed = true
                    if (activeScript?.disposeError !== undefined) throw activeScript.disposeError
                }
            }
        }
    }
    return { createAgentSession, calls, prompts, promptOptions, sessions }
}

export function isolatedModelRuntime(directory: string): Promise<ModelRuntime> {
    return ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false
    })
}

async function run(
    prompt: string,
    script: FakePiScript,
    options: CreateAgentSessionOptions,
    emit: (event: AgentSessionEvent) => void
): Promise<void> {
    const model = options.model
    if (model === undefined) throw new Error("fakePi requires a model")
    emit({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }
    })
    for (const message of script.customMessages ?? []) {
        emit({ type: "message_end", message: { role: "custom", ...message, timestamp: Date.now() } })
    }
    const content: PiAssistantContent[] = [
        ...(script.thinking ?? []).map((thinking) => ({ type: "thinking" as const, thinking })),
        ...(script.text ?? []).map((text) => ({ type: "text" as const, text })),
        ...(script.toolCalls ?? []).map((call) => ({
            type: "toolCall" as const,
            id: call.id ?? `tool_${randomUUID()}`,
            name: call.name,
            arguments: call.arguments
        }))
    ]
    if (content.length > 0) emit({ type: "message_end", message: assistantMessage(model, content, "toolUse") })
    const toolCalls = content.filter((block) => block.type === "toolCall")
    for (const [index, call] of (script.toolCalls ?? []).entries()) {
        if (call.change !== undefined) await applyChange(call.change, options.cwd ?? process.cwd())
        const toolCall = toolCalls[index]
        emit({ type: "message_end", message: toolResultMessage(toolCall.id, call) })
    }
    if (script.throwMidRun !== undefined) throw script.throwMidRun
    if (script.noFinalAssistant) return
    let finalResponse = script.finalResponse
    if (script.output !== undefined) finalResponse ??= taggedOutput(prompt, JSON.stringify(script.output))
    finalResponse ??= "done"
    const finalContent = (script.finalTextBlocks ?? [finalResponse]).map((text) => ({ type: "text" as const, text }))
    emit({
        type: "message_end",
        message: assistantMessage(model, finalContent, script.stopReason ?? "stop", script.errorMessage)
    })
}

function assistantMessage(
    model: NonNullable<CreateAgentSessionOptions["model"]>,
    content: PiAssistantContent[],
    stopReason: PiAssistantMessage["stopReason"],
    errorMessage?: string
): PiAssistantMessage {
    return {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
        timestamp: Date.now()
    }
}

function toolResultMessage(toolCallId: string, call: FakePiToolCall): PiToolResultMessage {
    return {
        role: "toolResult",
        toolCallId,
        toolName: call.name,
        content: [{ type: "text", text: call.result ?? "ok" }],
        isError: call.isError ?? false,
        timestamp: Date.now()
    }
}
