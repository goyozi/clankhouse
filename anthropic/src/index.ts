import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk"
import type { ContentBlock, Message, StopReason } from "@anthropic-ai/sdk/resources/messages"
import { BaseLanguageModel, type LanguageModelInvocation } from "@loopy/core/ai/base-llm"
import type { SessionRecorder } from "@loopy/core/ai/sessions"
import { LoopyError } from "@loopy/core/errors"

export type AnthropicModelOptions = {
    model: string
    maxTokens: number
    clientOptions?: ClientOptions
}

export class AnthropicModel extends BaseLanguageModel {
    readonly client = "anthropic"
    readonly provider = "anthropic"
    readonly model: string
    private readonly maxTokens: number
    private readonly clientOptions?: ClientOptions
    private sdkClient?: Anthropic

    constructor(options: AnthropicModelOptions) {
        super()
        this.model = options.model
        this.maxTokens = options.maxTokens
        this.clientOptions = options.clientOptions
    }

    protected async invoke(invocation: LanguageModelInvocation): Promise<unknown> {
        return this.invokeWithInstructedOutput(invocation, async (prompt) => {
            const response = await this.getClient()
                .messages.stream({
                    model: this.model,
                    max_tokens: this.maxTokens,
                    messages: [{ role: "user", content: prompt }]
                })
                .finalMessage()
            const finalMessage = response.content
                .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
                .map((block) => block.text)
                .join("")
            recordContent(invocation.session, response.content)
            requireCompleted(response.stop_reason)
            return finalMessage
        })
    }

    private getClient(): Anthropic {
        return (this.sdkClient ??= new Anthropic(this.clientOptions))
    }
}

function recordContent(session: SessionRecorder, content: Message["content"]): void {
    for (const block of content) {
        if (block.type === "redacted_thinking") continue
        if (block.type === "text") {
            session.addMessage("assistant", block.text)
        } else if (block.type === "thinking") {
            session.addMessage("reasoning", block.thinking)
        } else {
            throw new LoopyError(
                "llm_response_invalid",
                `Anthropic returned unexpected content block for a tool-free request: ${block.type}`
            )
        }
    }
}

function requireCompleted(stopReason: StopReason | null): void {
    if (stopReason === "end_turn" || stopReason === "stop_sequence") return
    if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded" || stopReason === "pause_turn") {
        throw new LoopyError("llm_response_incomplete", `Anthropic response stopped before completion: ${stopReason}`)
    }
    if (stopReason === "refusal") {
        throw new LoopyError("llm_response_failed", "Anthropic refused to produce a response")
    }
    if (stopReason === "tool_use") {
        throw new LoopyError("llm_response_invalid", "Anthropic stopped for tool use despite receiving no tools")
    }
    if (stopReason === null) {
        throw new LoopyError("llm_response_invalid", "Anthropic response did not include a stop reason")
    }
}
