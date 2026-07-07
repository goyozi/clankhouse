import * as z from "zod";

import { Prompt } from "./prompt"

export type ModelCallOptions<T extends z.ZodTypeAny> = {
    prompt: Prompt,
    output: T
}

export interface LanguageModel {
    /**
     * Durable step executing a single LLM call.
     */
    call<T extends z.ZodTypeAny>(stepName: string, options: ModelCallOptions<T>): Promise<z.infer<T>>
}
