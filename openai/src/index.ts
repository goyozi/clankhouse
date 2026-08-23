import OpenAI, { type ClientOptions } from "openai"
import type { Response, ResponseOutputItem } from "openai/resources/responses/responses"
import { BaseLanguageModel, type LanguageModelInvocation } from "@loopy/core/ai/base-llm"
import type { SessionRecorder } from "@loopy/core/ai/sessions"
import { LoopyError } from "@loopy/core/errors"

export type OpenAIModelOptions = {
    model: string
    store?: boolean
    clientOptions?: ClientOptions
}

export class OpenAIModel extends BaseLanguageModel {
    readonly client = "openai"
    readonly provider = "openai"
    readonly model: string
    private readonly store: boolean
    private readonly clientOptions?: ClientOptions
    private sdkClient?: OpenAI

    constructor(options: OpenAIModelOptions) {
        super()
        this.model = options.model
        this.store = options.store ?? false
        this.clientOptions = options.clientOptions
    }

    protected async invoke(invocation: LanguageModelInvocation): Promise<unknown> {
        return this.invokeWithInstructedOutput(invocation, async (prompt) => {
            const response = await this.getClient().responses.create({
                model: this.model,
                input: prompt,
                store: this.store
            })
            const output = recordOutput(invocation.session, response)
            requireCompleted(response)
            if (output.refusals.length > 0) {
                throw new LoopyError(
                    "llm_response_failed",
                    `OpenAI refused to produce a response: ${output.refusals.join("\n")}`
                )
            }
            if (output.assistantMessages.length === 0) {
                throw new LoopyError("llm_response_invalid", "OpenAI response did not contain text output")
            }
            return output.assistantMessages
        })
    }

    private getClient(): OpenAI {
        return (this.sdkClient ??= new OpenAI(this.clientOptions))
    }
}

function recordOutput(
    session: SessionRecorder,
    response: Response
): { assistantMessages: string[]; refusals: string[] } {
    const refusals: string[] = []
    const assistantMessages: string[] = []
    for (const output of response.output) {
        if (output.type === "reasoning") {
            const reasoning = reasoningText(output)
            if (reasoning !== "") session.addMessage("reasoning", reasoning)
        } else if (output.type === "message") {
            const text: string[] = []
            for (const content of output.content) {
                if (content.type === "output_text") {
                    text.push(content.text)
                    session.addMessage("assistant", content.text)
                } else {
                    refusals.push(content.refusal)
                    session.addMessage("assistant", content.refusal)
                }
            }
            if (text.length > 0) assistantMessages.push(text.join(""))
        } else {
            throw new LoopyError(
                "llm_response_invalid",
                `OpenAI returned unexpected output item for a tool-free request: ${output.type}`
            )
        }
    }
    return { assistantMessages, refusals }
}

function reasoningText(output: Extract<ResponseOutputItem, { type: "reasoning" }>): string {
    const content = output.content?.map((item) => item.text).join("") ?? ""
    return content === "" ? output.summary.map((item) => item.text).join("") : content
}

function requireCompleted(response: Response): void {
    if (response.error !== null) {
        const detail = response.error.message ?? response.error.code
        throw new LoopyError("llm_response_failed", `OpenAI response failed: ${detail}`)
    }
    if (response.status === "completed") return
    if (response.status === "incomplete" || response.status === "queued" || response.status === "in_progress") {
        const detail = response.incomplete_details?.reason ?? response.status
        throw new LoopyError("llm_response_incomplete", `OpenAI response was incomplete: ${detail}`)
    }
    if (response.status === "failed" || response.status === "cancelled") {
        throw new LoopyError("llm_response_failed", `OpenAI response failed: ${response.status}`)
    }
    if (response.status === undefined) {
        throw new LoopyError("llm_response_invalid", "OpenAI response did not include a status")
    }
}
