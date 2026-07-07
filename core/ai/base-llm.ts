import * as z from "zod"
import { requireContext } from "../context"
import type { LanguageModel, ModelCallOptions } from "./llm"
import { renderPrompt } from "./prompt"
import type { SessionRecorder } from "./sessions"

export type LanguageModelInvocation = {
    stepName: string
    prompt: string
    output: z.ZodTypeAny
    session: SessionRecorder
}

/**
 * Owns all durability concerns of an LLM call: the durable step, the persisted
 * session and its messages, prompt rendering and output validation.
 * Implementations only provide `invoke`, producing the structured output per
 * the provided output schema and recording all session messages they can
 * (system/user/assistant/tool), including the user's prompt.
 */
export abstract class BaseLanguageModel implements LanguageModel {
    abstract readonly provider: string
    abstract readonly model: string

    protected abstract invoke(invocation: LanguageModelInvocation): Promise<unknown>

    async call<T extends z.ZodTypeAny>(stepName: string, options: ModelCallOptions<T>): Promise<z.infer<T>> {
        const loopy = requireContext().loopy
        let session: SessionRecorder | undefined
        return loopy.engine.executeStep({
            kind: "llm",
            name: stepName,
            schema: options.output,
            execute: async (handle) => {
                const prompt = await renderPrompt(options.prompt)
                session = loopy.sessions.create({
                    kind: "llm",
                    provider: this.provider,
                    model: this.model
                })
                handle.set("session_id", session.id)
                return this.invoke({ stepName, prompt, output: options.output, session })
            },
            onSuccess: async () => session?.succeed(),
            onError: async () => session?.fail()
        })
    }
}
