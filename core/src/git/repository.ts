import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import * as path from "node:path"
import * as z from "zod"
import { requireContext } from "../context"
import { LoopyError } from "../errors"
import { exists, isNodeError, newId } from "../util"
import { mustGit } from "./exec"
import { captureState, restoreCapturedState, Worktree } from "./worktree"

const CandidateIdSchema = z.string().regex(/^[0-9A-Za-z]{21}$/)
const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

const WorktreeReferenceSchema = z
    .object({
        id: CandidateIdSchema
    })
    .strict()

const CandidateManifestSchema = z
    .object({
        repositoryPath: z.string(),
        seedMode: z.enum(["base", "uncommitted"]),
        seedOid: GitObjectIdSchema
    })
    .strict()

export type WorktreeReference = z.infer<typeof WorktreeReferenceSchema>
export type CandidateManifest = z.infer<typeof CandidateManifestSchema>

export type ManagedCandidate = CandidateManifest & {
    id: string
    root: string
    path: string
    seedRef: string
}

export class GitRepository {
    readonly path: string

    constructor(path: string) {
        this.path = path
    }

    /**
     * Durable workflow step creating an isolated worktree in the Loopy directory.
     *
     * Use exactly one of `base`, resolved and pinned on first execution, or `includeUncommitted: true`,
     * which captures the source HEAD, semantic index, tracked files, and non-ignored untracked files without
     * modifying the source index. `key` participates in normal durable-step identity.
     *
     * Replay restores the pinned seed without re-resolving the base and recreates a missing checkout at the
     * same path when its managed manifest, repository, and seed remain valid. Ignored files are preserved in
     * an existing checkout but are excluded from capture and may be absent after recreation. Empty directories,
     * filesystem metadata, submodule working directories, files outside the checkout, and external side effects
     * are also excluded. The caller must prevent concurrent source mutations during capture.
     */
    async worktree(options: WorktreeOptions): Promise<Worktree> {
        const ctx = requireContext()
        const repositoryPath = await realpath(this.path)
        const stepName = options.key === undefined ? "worktree" : `worktree:${options.key}`
        return ctx.loopy.engine.executeStep({
            kind: "worktree",
            name: stepName,
            schema: worktreeOutputSchema(ctx.loopy.loopyDir),
            schemaIo: "input",
            execute: () => createWorktree(ctx.loopy.loopyDir, repositoryPath, options),
            onReplay: async (row) => {
                if (row.output === null) throw unavailable("Worktree step has no recorded checkout")
                const reference = parseWorktreeReference(JSON.parse(row.output))
                await restoreRecordedWorktree(ctx.loopy.loopyDir, repositoryPath, reference)
            }
        })
    }
}

async function createWorktree(
    loopyDir: string,
    repositoryPath: string,
    options: WorktreeOptions
): Promise<WorktreeReference> {
    const seedMode = options.includeUncommitted === true ? "uncommitted" : "base"
    const seedOid =
        seedMode === "base"
            ? (await mustGit(repositoryPath, ["rev-parse", `${options.base}^{commit}`])).stdout.trim()
            : (await captureState(repositoryPath, "loopy worktree seed")).envelopeCommit
    const manifest: CandidateManifest = {
        repositoryPath,
        seedMode,
        seedOid
    }
    const candidate = resolveCandidate(loopyDir, newId(), manifest)
    await mkdir(candidate.root, { recursive: true })
    const pendingManifest = `${candidateManifestFile(candidate.root)}.tmp`
    await writeFile(pendingManifest, JSON.stringify(manifest))
    await rename(pendingManifest, candidateManifestFile(candidate.root))
    await mustGit(repositoryPath, ["update-ref", candidate.seedRef, candidate.seedOid, ""])
    await materializeCandidate(candidate)
    return { id: candidate.id }
}

async function restoreRecordedWorktree(
    loopyDir: string,
    repositoryPath: string,
    reference: WorktreeReference
): Promise<void> {
    const candidatePath = candidateCheckoutPath(loopyDir, reference.id)
    try {
        const manifest = await loadCandidateManifest(candidateRoot(loopyDir, reference.id))
        if (manifest.repositoryPath !== repositoryPath) throw new Error("repository path changed")
        const candidate = resolveCandidate(loopyDir, reference.id, manifest)
        await validateSeed(candidate)
        if (await exists(candidate.path)) {
            await restoreCandidate(candidate)
            return
        }
        if (await isWorktreeRegistered(repositoryPath, candidate.path)) {
            await mustGit(repositoryPath, ["worktree", "remove", "--force", candidate.path])
        }
        await materializeCandidate(candidate)
    } catch (error) {
        throw unavailable(`Recorded worktree is unavailable: ${candidatePath}`, error)
    }
}

async function validateSeed(candidate: ManagedCandidate): Promise<void> {
    const result = await mustGit(candidate.repositoryPath, ["rev-parse", `${candidate.seedRef}^{commit}`])
    if (result.stdout.trim() !== candidate.seedOid) throw new Error("worktree seed ref changed")
}

async function restoreCandidate(candidate: ManagedCandidate): Promise<void> {
    if (candidate.seedMode === "base") {
        await mustGit(candidate.path, ["reset", "--hard"])
        await mustGit(candidate.path, ["clean", "-fd"])
        await mustGit(candidate.path, ["checkout", "--detach", "--force", candidate.seedOid])
    } else {
        await restoreCapturedState(candidate.path, candidate.seedOid)
    }
}

async function materializeCandidate(candidate: ManagedCandidate): Promise<void> {
    if (candidate.seedMode === "base") {
        await mustGit(candidate.repositoryPath, ["worktree", "add", "--detach", candidate.path, candidate.seedOid])
    } else {
        await mustGit(candidate.repositoryPath, [
            "worktree",
            "add",
            "--detach",
            candidate.path,
            `${candidate.seedOid}^`
        ])
        await restoreCapturedState(candidate.path, candidate.seedOid)
    }
}

function worktreeOutputSchema(loopyDir: string) {
    return WorktreeReferenceSchema.transform(({ id }) => new Worktree(candidateCheckoutPath(loopyDir, id)))
}

export function parseWorktreeReference(value: unknown): WorktreeReference {
    return WorktreeReferenceSchema.parse(value)
}

export async function readCandidateManifest(candidateRootPath: string): Promise<CandidateManifest | undefined> {
    try {
        return await loadCandidateManifest(candidateRootPath)
    } catch {
        return undefined
    }
}

async function loadCandidateManifest(candidateRootPath: string): Promise<CandidateManifest> {
    return CandidateManifestSchema.parse(JSON.parse(await readFile(candidateManifestFile(candidateRootPath), "utf8")))
}

export function resolveCandidate(loopyDir: string, id: string, manifest: CandidateManifest): ManagedCandidate {
    return {
        ...manifest,
        id,
        root: candidateRoot(loopyDir, id),
        path: candidateCheckoutPath(loopyDir, id),
        seedRef: candidateSeedRef(id)
    }
}

function candidateRoot(loopyDir: string, id: string): string {
    return path.join(loopyDir, "worktrees", id)
}

export function candidateCheckoutPath(loopyDir: string, id: string): string {
    return path.join(candidateRoot(loopyDir, id), "checkout")
}

function candidateSeedRef(id: string): string {
    return `refs/loopy/worktrees/${id}/seed`
}

export async function isWorktreeRegistered(repositoryPath: string, checkoutPath: string): Promise<boolean> {
    const output = await mustGit(repositoryPath, ["worktree", "list", "--porcelain", "-z"])
    const expectedPath = await canonicalPath(checkoutPath)
    for (const field of output.stdout.split("\0")) {
        if (!field.startsWith("worktree ")) continue
        if ((await canonicalPath(field.slice("worktree ".length))) === expectedPath) return true
    }
    return false
}

async function canonicalPath(target: string): Promise<string> {
    const original = path.resolve(target)
    const suffix: string[] = []
    let current = original
    while (true) {
        try {
            return path.join(await realpath(current), ...suffix)
        } catch (error) {
            const parent = path.dirname(current)
            if (!isNodeError(error, "ENOENT") || parent === current) return original
            suffix.unshift(path.basename(current))
            current = parent
        }
    }
}

function candidateManifestFile(candidateRootPath: string): string {
    return path.join(candidateRootPath, "candidate.json")
}

function unavailable(message: string, cause?: unknown): LoopyError {
    return new LoopyError("git_worktree_unavailable", message, cause === undefined ? undefined : { cause })
}

export type WorktreeOptions = { key?: string } & (
    { base: string; includeUncommitted?: false } | { base?: never; includeUncommitted: true }
)
