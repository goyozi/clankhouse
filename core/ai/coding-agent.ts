import * as z from "zod";

import { Worktree } from "../git"
import { Prompt } from "./prompt"

export type CodingRunOptions<T extends z.ZodTypeAny> = {
    prompt: Prompt,
    output: T,
    worktree: Worktree
}

export interface CodingAgent {
    /**
     * Durable step executing a coding agent session.
     * Takes a snapshot after agent session ends.
     * Re-running stored step restores the snapshot in addition to returning stored output.
     */
    run<T extends z.ZodTypeAny>(stepName: string, options: CodingRunOptions<T>): Promise<z.infer<T>>
}
