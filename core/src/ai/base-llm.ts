import * as z from "zod"
import { requireContext } from "../context"
import { prepareInstructedOutput } from "./instructed-output"
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
 * the provided output schema and recording all session messages and tool
 * activity they can, including the user's prompt.
 */
export abstract class BaseLanguageModel implements LanguageModel {
    abstract readonly provider: string
    abstract readonly model: string

    protected abstract invoke(invocation: LanguageModelInvocation): Promise<unknown>

    protected async invokeWithInstructedOutput(
        invocation: LanguageModelInvocation,
        run: (prompt: string) => Promise<string | undefined>
    ): Promise<unknown> {
        const prepared = prepareInstructedOutput(invocation.prompt, invocation.output, "llm")
        invocation.session.addMessage("user", prepared.prompt)
        const finalMessage = await run(prepared.prompt)
        return prepared.collect(finalMessage)
    }

    async call<T extends z.ZodTypeAny>(stepName: string, options: ModelCallOptions<T>): Promise<z.infer<T>> {
        const role = `LLM "${stepName}" output schema`
        const loopy = requireContext().loopy
        let session: SessionRecorder | undefined
        return loopy.engine.executeStep({
            kind: "llm",
            name: stepName,
            schema: options.output,
            schemaIo: "input",
            schemaRole: role,
            allowTopLevelVoid: false,
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
