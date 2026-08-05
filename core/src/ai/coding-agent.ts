import * as z from "zod"

import { Worktree } from "../git"
import { Prompt } from "./prompt"

export type CodingRunOptions<T extends z.ZodTypeAny> = {
    prompt: Prompt
    output: T
    worktree: Worktree
    snapshot?: boolean
}

export interface CodingAgent {
    /**
     * Durable step executing a coding agent session.
     * By default, takes a snapshot after the session ends and restores it when replaying the stored step.
     * Pass `snapshot: false` to skip both operations. Replay rejects changes to the recorded snapshot mode.
     */
    run<T extends z.ZodTypeAny>(stepName: string, options: CodingRunOptions<T>): Promise<z.infer<T>>
}
