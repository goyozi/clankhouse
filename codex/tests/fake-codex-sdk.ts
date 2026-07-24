import { randomUUID } from "node:crypto"
import type { CodexOptions, Input, ThreadEvent, ThreadItem, ThreadOptions, TurnOptions } from "@openai/codex-sdk"
import type { CodexFactory } from "@loopy/codex"
import { applyChange, type FakeChange } from "@loopy/core/ai/fake-agent"
import { taggedOutput } from "@loopy/test-utils"

export type FakeCodexItem = {
    started?: ThreadItem
    updates?: ThreadItem[]
    completed?: ThreadItem
    change?: FakeChange
}

export type FakeCodexScript = {
    items?: FakeCodexItem[]
    output?: unknown
    finalResponse?: string
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
                        return { events: run(input, script(input), options) }
                    }
                }
            }
        }
    }
    return { codexFactory, clientOptions, threadOptions, runCalls }
}

async function* run(
    prompt: string,
    script: FakeCodexScript,
    options: ThreadOptions | undefined
): AsyncGenerator<ThreadEvent> {
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
    let finalResponse = script.finalResponse
    if (script.output !== undefined) finalResponse ??= taggedOutput(prompt, JSON.stringify(script.output))
    if (finalResponse !== undefined) {
        yield {
            type: "item.completed",
            item: { id: "agent_final", type: "agent_message", text: finalResponse }
        }
    }
    if (script.endWithoutCompletion) return
    yield {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
    }
}
