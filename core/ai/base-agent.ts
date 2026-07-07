import * as z from "zod"
import { requireContext } from "../context"
import type { Worktree } from "../git"
import { uniqueName } from "../util"
import type { CodingAgent, CodingRunOptions } from "./coding-agent"
import { renderPrompt } from "./prompt"
import type { SessionRecorder } from "./sessions"

export type CodingAgentInvocation = {
    stepName: string
    prompt: string
    output: z.ZodTypeAny
    worktree: Worktree
    session: SessionRecorder
}

/**
 * Owns all durability concerns of a coding agent session: the durable step,
 * the persisted session and its messages, prompt rendering, output validation
 * and worktree snapshotting. Replaying a stored step restores the snapshot.
 * Implementations only provide `invoke`, driving the agent against the worktree,
 * instructing it to format its final output per the provided output schema and
 * recording all session messages they can (system/user/assistant/tool),
 * including the user's prompt.
 */
export abstract class BaseCodingAgent implements CodingAgent {
    abstract readonly provider: string
    abstract readonly model: string

    protected abstract invoke(invocation: CodingAgentInvocation): Promise<unknown>

    async run<T extends z.ZodTypeAny>(stepName: string, options: CodingRunOptions<T>): Promise<z.infer<T>> {
        const ctx = requireContext()
        let session: SessionRecorder | undefined
        return ctx.loopy.engine.executeStep({
            kind: "agent",
            name: stepName,
            schema: options.output,
            execute: async (handle) => {
                const prompt = await renderPrompt(options.prompt)
                session = ctx.loopy.sessions.create({
                    kind: "coding-agent",
                    provider: this.provider,
                    model: this.model
                })
                handle.set("session_id", session.id)
                return this.invoke({
                    stepName,
                    prompt,
                    output: options.output,
                    worktree: options.worktree,
                    session
                })
            },
            onSuccess: async (handle) => {
                const ref = await options.worktree.snapshotRef(
                    `refs/loopy/agent/${uniqueName(`${ctx.workflowName}/${ctx.runKey}`)}/${ctx.attempt}/${uniqueName(handle.stepKey)}`
                )
                handle.set("snapshot_ref", ref)
                session?.succeed()
            },
            onError: async () => session?.fail(),
            onReplay: async (row) => {
                if (row.snapshot_ref === null) {
                    throw new Error(`Agent step "${row.key}" has no worktree snapshot to restore`)
                }
                await options.worktree.restoreRef(row.snapshot_ref)
            }
        })
    }
}
