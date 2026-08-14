import * as z from "zod"
import { requireContext } from "../context"
import { LoopyError } from "../errors"
import type { Worktree } from "../git"
import { uniqueName } from "../util"
import type { CodingAgent, CodingRunOptions } from "./coding-agent"
import { prepareInstructedOutput } from "./instructed-output"
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
 * Implementations only provide `invoke`, driving the agent against the worktree
 * and recording all session messages and tool activity they can,
 * including the user's prompt. Providers can use `invokeWithInstructedOutput`
 * for the shared instructed-output prompt and parser.
 */
export abstract class BaseCodingAgent implements CodingAgent {
    abstract readonly client: string
    abstract readonly provider: string
    abstract readonly model: string

    protected abstract invoke(invocation: CodingAgentInvocation): Promise<unknown>

    protected async invokeWithInstructedOutput(
        invocation: CodingAgentInvocation,
        run: (prompt: string) => Promise<string | undefined>
    ): Promise<unknown> {
        const prepared = prepareInstructedOutput(invocation.prompt, invocation.output, "coding-agent")
        invocation.session.addMessage("user", prepared.prompt)
        const finalMessage = await run(prepared.prompt)
        return prepared.collect(finalMessage)
    }

    async run<T extends z.ZodTypeAny>(stepName: string, options: CodingRunOptions<T>): Promise<z.infer<T>> {
        const role = `Coding agent "${stepName}" output schema`
        const ctx = requireContext()
        const snapshot = options.snapshot ?? true
        let session: SessionRecorder | undefined
        return ctx.loopy.engine.executeStep({
            kind: "agent",
            name: stepName,
            schema: options.output,
            schemaIo: "input",
            schemaRole: role,
            execute: async (handle) => {
                handle.set("snapshot_enabled", snapshot ? 1 : 0)
                const prompt = await renderPrompt(options.prompt)
                session = ctx.loopy.sessions.create({
                    kind: "coding-agent",
                    client: this.client,
                    provider: this.provider,
                    model: this.model,
                    filesRoot: options.worktree.path
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
                if (snapshot) {
                    const ref = await options.worktree.snapshotRef(
                        `refs/loopy/agent/${uniqueName(`${ctx.workflowName}/${ctx.runKey}`)}/${ctx.attempt}/${uniqueName(handle.stepKey)}`
                    )
                    handle.set("snapshot_ref", ref)
                }
                session?.succeed()
            },
            onError: async () => session?.fail(),
            onReplay: async (row) => {
                const recordedSnapshot = row.snapshot_enabled === 1
                if (recordedSnapshot !== snapshot) {
                    throw new LoopyError(
                        "coding_agent_snapshot_mismatch",
                        `Agent step "${row.key}" was recorded with snapshots ${recordedSnapshot ? "enabled" : "disabled"} but replay requested snapshots ${snapshot ? "enabled" : "disabled"}`
                    )
                }
                if (!snapshot) return
                if (row.snapshot_ref === null) {
                    throw new LoopyError(
                        "coding_agent_snapshot_missing",
                        `Agent step "${row.key}" has no worktree snapshot to restore`
                    )
                }
                await options.worktree.restoreRef(row.snapshot_ref)
            }
        })
    }
}
