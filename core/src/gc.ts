import { rm } from "node:fs/promises"
import * as path from "node:path"
import * as sql from "./db.js"
import type { Db } from "./db.js"
import type { ActiveSets } from "./runtime.js"

export async function gcRuns(
    clankhouseDir: string,
    db: Db,
    active: ActiveSets,
    endedBefore: Date
): Promise<RunGcResult> {
    markDeleting(db, active, endedBefore.toISOString())
    const deleted = sql.findRunsByGcState(db, "deleting")
    for (const runId of deleted) {
        await rm(path.join(clankhouseDir, "artifacts", runId), { recursive: true, force: true })
        db.transaction(() => {
            sql.deleteRunData(db, runId)
            sql.setRunGcState(db, runId, "deleted")
        })()
    }
    return { deleted: deleted.length }
}

function markDeleting(db: Db, active: ActiveSets, endedBefore: string): void {
    const busy = new Set(active.runs.keys())
    for (const stepId of active.steps) {
        const step = sql.findStepById(db, stepId)
        if (step) busy.add(step.run_id)
    }
    db.transaction(() => {
        for (const runId of sql.findRunGcCandidates(db, endedBefore)) {
            if (!busy.has(runId)) sql.setRunGcState(db, runId, "deleting")
        }
    })()
}

export type RunGcResult = { deleted: number }
