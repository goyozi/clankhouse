import { AsyncLocalStorage } from "node:async_hooks"
import type { ClankHouse } from "./clankhouse.js"
import { ClankHouseError } from "./errors.js"

export type RunContext = {
    clankhouse: ClankHouse
    runId: string
    runKey: string
    workflowName: string
    attempt: number
    prefixes: string[]
    seenStepKeys: Set<string>
    seq: { next: number }
}

export const runContext = new AsyncLocalStorage<RunContext>()

export function requireContext(): RunContext {
    const ctx = runContext.getStore()
    if (!ctx) throw new ClankHouseError("workflow_context_required", "Must be called inside a workflow run")
    return ctx
}
