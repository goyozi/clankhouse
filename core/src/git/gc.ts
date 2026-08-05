import { lstat, readdir, rm } from "node:fs/promises"
import * as path from "node:path"
import type { Db } from "../db"
import * as sql from "../db"
import { LoopyError } from "../errors"
import { exists } from "../util"
import {
    candidateCheckoutPath,
    isWorktreeRegistered,
    parseWorktreeReference,
    readCandidateManifest,
    resolveCandidate,
    type ManagedCandidate
} from "./repository"
import { execGit, mustGit } from "./exec"
import { removeStaleRescueRefs } from "./worktree"

const WORKTREE_GC_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Collects Loopy-managed worktree candidates not referenced by any succeeded worktree step and at least
 * fourteen days old. Reachability is validated before deletion; malformed durable rows fail the sweep closed.
 * Valid seed refs are deleted only when they still target their recorded object, and a missing seed ref is
 * treated as already cleaned up by an earlier interrupted sweep. Temporary restore refs older than fourteen
 * days are removed from repositories discoverable through valid candidate manifests. Calls for the same Loopy
 * directory must not overlap. Old unreachable candidates with invalid manifests are removed as filesystem
 * state without attempting to repair undiscoverable Git metadata, while inconsistencies in discoverable Git
 * metadata abort the sweep for manual repair. This does not delete runs or user or agent snapshot refs, and
 * it does not compact Git objects.
 */
export async function gcWorktrees(loopyDir: string, db: Db): Promise<WorktreeGcResult> {
    const worktreesRoot = path.join(loopyDir, "worktrees")
    const reachable = reachableWorktrees(db)
    if (!(await exists(worktreesRoot))) return { removed: 0, paths: [] }
    const candidates = await candidateDirectories(worktreesRoot)
    const repositories = new Set<string>()
    const removed: string[] = []
    for (const candidateRoot of candidates) {
        const id = path.basename(candidateRoot)
        const candidateStats = await lstat(candidateRoot)
        const manifest = await readCandidateManifest(candidateRoot)
        if (manifest !== undefined) repositories.add(manifest.repositoryPath)
        if (reachable.has(id)) continue
        if (Date.now() - candidateStats.mtimeMs < WORKTREE_GC_MIN_AGE_MS) continue
        if (manifest !== undefined) await removeGitState(resolveCandidate(loopyDir, id, manifest))
        await rm(candidateRoot, { recursive: true, force: true })
        removed.push(candidateCheckoutPath(loopyDir, id))
    }
    for (const repositoryPath of [...repositories].sort()) {
        if (!(await exists(repositoryPath))) continue
        try {
            await removeStaleRescueRefs(repositoryPath, Date.now() - WORKTREE_GC_MIN_AGE_MS)
        } catch (error) {
            throw gcFailure(`Could not remove stale restore refs from ${repositoryPath}`, error)
        }
    }
    removed.sort()
    return { removed: removed.length, paths: removed }
}

function reachableWorktrees(db: Db): Set<string> {
    const reachable = new Set<string>()
    for (const row of sql.findSucceededWorktreeSteps(db)) {
        if (row.output === null) throw gcFailure(`Succeeded worktree step has no output: ${row.id}`)
        try {
            reachable.add(parseWorktreeReference(JSON.parse(row.output)).id)
        } catch (error) {
            throw gcFailure(`Invalid durable worktree reference in step ${row.id}`, error)
        }
    }
    return reachable
}

async function candidateDirectories(worktreesRoot: string): Promise<string[]> {
    const candidates = (await readdir(worktreesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(worktreesRoot, entry.name))
    candidates.sort()
    return candidates
}

async function removeGitState(candidate: ManagedCandidate): Promise<void> {
    if (!(await exists(candidate.repositoryPath))) return
    const seed = await execGit(candidate.repositoryPath, ["rev-parse", `${candidate.seedRef}^{commit}`])
    if (seed.exitCode === 0 && seed.stdout.trim() !== candidate.seedOid) {
        throw gcFailure(`Worktree seed ref changed: ${candidate.seedRef}`)
    }
    if (await isWorktreeRegistered(candidate.repositoryPath, candidate.path)) {
        await mustGit(candidate.repositoryPath, ["worktree", "remove", "--force", candidate.path]).catch((error) => {
            throw gcFailure(`Could not remove worktree ${candidate.path}`, error)
        })
    }
    if (seed.exitCode === 0) {
        await mustGit(candidate.repositoryPath, ["update-ref", "-d", candidate.seedRef, candidate.seedOid]).catch(
            (error) => {
                throw gcFailure(`Could not delete worktree seed ref ${candidate.seedRef}`, error)
            }
        )
    }
}

function gcFailure(message: string, cause?: unknown): LoopyError {
    return new LoopyError("git_worktree_gc_failed", message, cause === undefined ? undefined : { cause })
}

export type WorktreeGcResult = { removed: number; paths: string[] }
