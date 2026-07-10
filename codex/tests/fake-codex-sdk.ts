import { randomUUID } from "node:crypto"
import type { CodexOptions, Input, ThreadEvent, ThreadItem, ThreadOptions, TurnOptions } from "@openai/codex-sdk"
import type { CodexFactory } from "@loopy/codex/ai/codex-agent"
import { applyChange, type FakeChange } from "@loopy/core/ai/fake-agent"

export type FakeCodexItem = {
    started?: ThreadItem
    updates?: ThreadItem[]
    completed?: ThreadItem
    change?: FakeChange
}

export type FakeCodexScript = {
    items?: FakeCodexItem[]
    output?: unknown
    outputText?: string
    turnFailure?: string
    streamError?: string
    throwMidStream?: Error
    endWithoutCompletion?: boolean
}

export type FakeCodexRunCall = {
    input: Input
    options: TurnOptions | undefined
}

export function fakeCodex(script: (prompt: string) => FakeCodexScript): {
    codexFactory: CodexFactory
    clientOptions: CodexOptions[]
    threadOptions: ThreadOptions[]
    runCalls: FakeCodexRunCall[]
} {
    const clientOptions: CodexOptions[] = []
    const threadOptions: ThreadOptions[] = []
    const runCalls: FakeCodexRunCall[] = []
    const codexFactory: CodexFactory = (options) => {
        clientOptions.push(options)
        return {
            startThread(options) {
                threadOptions.push(options ?? {})
                return {
                    async runStreamed(input, turnOptions) {
                        runCalls.push({ input, options: turnOptions })
                        if (typeof input !== "string") throw new Error("fakeCodex supports only string prompts")
                        return { events: run(script(input), options) }
                    }
                }
            }
        }
    }
    return { codexFactory, clientOptions, threadOptions, runCalls }
}

async function* run(script: FakeCodexScript, options: ThreadOptions | undefined): AsyncGenerator<ThreadEvent> {
    yield { type: "thread.started", thread_id: randomUUID() }
    yield { type: "turn.started" }
    if (script.throwMidStream) throw script.throwMidStream
    for (const scriptedItem of script.items ?? []) {
        if (scriptedItem.started !== undefined) yield { type: "item.started", item: scriptedItem.started }
        for (const update of scriptedItem.updates ?? []) yield { type: "item.updated", item: update }
        if (scriptedItem.change) {
            await applyChange(scriptedItem.change, options?.workingDirectory ?? process.cwd())
        }
        const completed = scriptedItem.completed ?? scriptedItem.started
        if (completed !== undefined) yield { type: "item.completed", item: completed }
    }
    if (script.streamError !== undefined) {
        yield { type: "error", message: script.streamError }
        return
    }
    if (script.turnFailure !== undefined) {
        yield { type: "turn.failed", error: { message: script.turnFailure } }
        return
    }
    const finalText = script.outputText ?? (script.output === undefined ? undefined : JSON.stringify(script.output))
    if (finalText !== undefined) {
        yield {
            type: "item.completed",
            item: { id: "agent_final", type: "agent_message", text: finalText }
        }
    }
    if (script.endWithoutCompletion) return
    yield {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
    }
}
