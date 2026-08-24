import * as z from "zod"
import { requireContext } from "../context.js"
import { prepareInstructedOutput } from "./instructed-output.js"
import type { LanguageModel, ModelCallOptions } from "./llm.js"
import { renderPrompt } from "./prompt.js"
import type { SessionRecorder } from "./sessions.js"

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
    abstract readonly client: string
    abstract readonly provider: string
    abstract readonly model: string

    protected abstract invoke(invocation: LanguageModelInvocation): Promise<unknown>

    protected async invokeWithInstructedOutput(
        invocation: LanguageModelInvocation,
        run: (prompt: string) => Promise<readonly string[]>
    ): Promise<unknown> {
        const prepared = prepareInstructedOutput(invocation.prompt, invocation.output, "llm")
        invocation.session.addMessage("user", prepared.prompt)
        const assistantMessages = await run(prepared.prompt)
        return prepared.collect(assistantMessages)
    }

    async call<T extends z.ZodTypeAny>(stepName: string, options: ModelCallOptions<T>): Promise<z.infer<T>> {
        const role = `LLM "${stepName}" output schema`
        const clankhouse = requireContext().clankhouse
        let session: SessionRecorder | undefined
        return clankhouse.engine.executeStep({
            kind: "llm",
            name: stepName,
            schema: options.output,
            schemaIo: "input",
            schemaRole: role,
            allowTopLevelVoid: false,
            execute: async (handle) => {
                const prompt = await renderPrompt(options.prompt)
                session = clankhouse.sessions.create({
                    kind: "llm",
                    client: this.client,
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
