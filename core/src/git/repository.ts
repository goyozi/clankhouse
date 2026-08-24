import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import * as path from "node:path"
import * as z from "zod"
import { requireContext } from "../context.js"
import { ClankHouseError } from "../errors.js"
import { exists, isNodeError, newId } from "../util.js"
import * as git from "./client.js"
import { captureState, restoreCapturedState, Worktree } from "./worktree.js"

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
     * Durable workflow step creating an isolated worktree in the ClankHouse directory.
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
        return ctx.clankhouse.engine.executeStep({
            kind: "worktree",
            name: stepName,
            schema: worktreeOutputSchema(ctx.clankhouse.clankhouseDir),
            schemaIo: "input",
            execute: () => createWorktree(ctx.clankhouse.clankhouseDir, repositoryPath, options),
            onReplay: async (row) => {
                if (row.output === null) throw unavailable("Worktree step has no recorded checkout")
                const reference = parseWorktreeReference(JSON.parse(row.output))
                await restoreRecordedWorktree(ctx.clankhouse.clankhouseDir, repositoryPath, reference)
            }
        })
    }

    /**
     * Apply changes made in the worktree to the repository.
     *
     * All changes to non-ignored files (committed or not) are applied as unstaged changes.
     * The repository must no staged, unstaged, or non-ignored untracked changes.
     *
     * This operation is not durable and not idempotent.
     * The repository must not be concurrently modified while this operation is in progress.
     */
    async applyChanges(worktree: Worktree): Promise<void> {
        try {
            await applyChanges(this.path, worktree.path)
        } catch (error) {
            if (error instanceof ClankHouseError && error.code === "git_apply_changes_failed") throw error
            throw applyFailure("Could not apply source changes", error)
        }
    }
}

async function createWorktree(
    clankhouseDir: string,
    repositoryPath: string,
    options: WorktreeOptions
): Promise<WorktreeReference> {
    const seedMode = options.includeUncommitted === true ? "uncommitted" : "base"
    const seedOid =
        seedMode === "base"
            ? await git.revParse(repositoryPath, `${options.base}^{commit}`)
            : (await captureState(repositoryPath, "clankhouse worktree seed")).envelopeCommit
    const manifest: CandidateManifest = {
        repositoryPath,
        seedMode,
        seedOid
    }
    const candidate = resolveCandidate(clankhouseDir, newId(), manifest)
    await mkdir(candidate.root, { recursive: true })
    const pendingManifest = `${candidateManifestFile(candidate.root)}.tmp`
    await writeFile(pendingManifest, JSON.stringify(manifest))
    await rename(pendingManifest, candidateManifestFile(candidate.root))
    await git.updateRef(repositoryPath, candidate.seedRef, candidate.seedOid, "")
    await materializeCandidate(candidate)
    return { id: candidate.id }
}

async function restoreRecordedWorktree(
    clankhouseDir: string,
    repositoryPath: string,
    reference: WorktreeReference
): Promise<void> {
    const candidatePath = candidateCheckoutPath(clankhouseDir, reference.id)
    try {
        const manifest = await loadCandidateManifest(candidateRoot(clankhouseDir, reference.id))
        if (manifest.repositoryPath !== repositoryPath) throw new Error("repository path changed")
        const candidate = resolveCandidate(clankhouseDir, reference.id, manifest)
        await validateSeed(candidate)
        if (await exists(candidate.path)) {
            await restoreCandidate(candidate)
            return
        }
        if (await isWorktreeRegistered(repositoryPath, candidate.path)) {
            await git.worktreeRemove(repositoryPath, candidate.path)
        }
        await materializeCandidate(candidate)
    } catch (error) {
        throw unavailable(`Recorded worktree is unavailable: ${candidatePath}`, error)
    }
}

async function validateSeed(candidate: ManagedCandidate): Promise<void> {
    const seedOid = await git.revParse(candidate.repositoryPath, `${candidate.seedRef}^{commit}`)
    if (seedOid !== candidate.seedOid) throw new Error("worktree seed ref changed")
}

async function restoreCandidate(candidate: ManagedCandidate): Promise<void> {
    if (candidate.seedMode === "base") {
        await git.resetHard(candidate.path)
        await git.clean(candidate.path)
        await git.checkoutDetached(candidate.path, candidate.seedOid)
    } else {
        await restoreCapturedState(candidate.path, candidate.seedOid)
    }
}

async function materializeCandidate(candidate: ManagedCandidate): Promise<void> {
    if (candidate.seedMode === "base") {
        await git.worktreeAdd(candidate.repositoryPath, candidate.path, candidate.seedOid)
    } else {
        await git.worktreeAdd(candidate.repositoryPath, candidate.path, `${candidate.seedOid}^`)
        await restoreCapturedState(candidate.path, candidate.seedOid)
    }
}

function worktreeOutputSchema(clankhouseDir: string) {
    return WorktreeReferenceSchema.transform(({ id }) => new Worktree(candidateCheckoutPath(clankhouseDir, id)))
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

export function resolveCandidate(clankhouseDir: string, id: string, manifest: CandidateManifest): ManagedCandidate {
    return {
        ...manifest,
        id,
        root: candidateRoot(clankhouseDir, id),
        path: candidateCheckoutPath(clankhouseDir, id),
        seedRef: candidateSeedRef(id)
    }
}

function candidateRoot(clankhouseDir: string, id: string): string {
    return path.join(clankhouseDir, "worktrees", id)
}

export function candidateCheckoutPath(clankhouseDir: string, id: string): string {
    return path.join(candidateRoot(clankhouseDir, id), "checkout")
}

function candidateSeedRef(id: string): string {
    return `refs/clankhouse/worktrees/${id}/seed`
}

export async function isWorktreeRegistered(repositoryPath: string, checkoutPath: string): Promise<boolean> {
    const expectedPath = await canonicalPath(checkoutPath)
    for (const worktreePath of await git.listWorktreePaths(repositoryPath)) {
        if ((await canonicalPath(worktreePath)) === expectedPath) return true
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

function unavailable(message: string, cause?: unknown): ClankHouseError {
    return new ClankHouseError("git_worktree_unavailable", message, cause === undefined ? undefined : { cause })
}

export type WorktreeOptions = { key?: string } & (
    { base: string; includeUncommitted?: false } | { base?: never; includeUncommitted: true }
)

async function applyChanges(targetPath: string, sourcePath: string): Promise<void> {
    const context = await validateApplyChanges(targetPath, sourcePath)
    const mergedTree = await mergeSourceChanges(context)
    const patch = await prepareChangesPatch(context.target, context.targetHead, mergedTree)
    if (patch.length === 0) return
    await applyPreparedChanges(context.target, context.targetHead, patch)
}

type ApplyChangesContext = {
    target: string
    source: string
    targetHead: string
}

async function validateApplyChanges(targetPath: string, sourcePath: string): Promise<ApplyChangesContext> {
    const target = await checkoutRoot(targetPath, "Target")
    const source = await checkoutRoot(sourcePath, "Source")
    if (target === source) throw applyFailure("Source and target must be different Git worktrees")

    const [targetCommonDirectory, sourceCommonDirectory] = await Promise.all([
        canonicalPath(await git.commonDirectory(target)),
        canonicalPath(await git.commonDirectory(source))
    ])
    if (targetCommonDirectory !== sourceCommonDirectory) {
        throw applyFailure("Source and target must belong to the same Git repository")
    }

    const [targetHead, sourceHead] = await Promise.all([
        git.tryRevParse(target, "HEAD^{commit}"),
        git.tryRevParse(source, "HEAD^{commit}")
    ])
    if (targetHead === undefined) throw applyFailure("Target must have a committed HEAD")
    if (sourceHead === undefined) throw applyFailure("Source must have a committed HEAD")
    if (await operationInProgress(target)) throw applyFailure("Target has a Git operation in progress")
    if (await operationInProgress(source)) throw applyFailure("Source has a Git operation in progress")
    if (await git.hasUnmergedEntries(source)) throw applyFailure("Source has unresolved conflicts")
    await requireCleanTarget(target)
    return { target, source, targetHead }
}

async function mergeSourceChanges({ target, source, targetHead }: ApplyChangesContext): Promise<string> {
    let sourceState: Awaited<ReturnType<typeof captureState>>
    try {
        sourceState = await captureState(source, "clankhouse apply changes")
    } catch (error) {
        throw applyFailure("Could not capture source changes", error)
    }

    let mergedTree: string
    try {
        mergedTree = await git.mergeTree(target, targetHead, sourceState.workingCommit)
    } catch (error) {
        throw applyFailure("Source changes do not apply cleanly to the target", error)
    }

    if (await changesGitLinks(target, targetHead, mergedTree)) {
        throw applyFailure("Source changes include submodule pointer updates, which cannot be applied to the target")
    }
    return mergedTree
}

async function prepareChangesPatch(target: string, targetHead: string, mergedTree: string): Promise<Buffer> {
    try {
        const patch = await git.diffBinary(target, targetHead, mergedTree)
        if (patch.length > 0) await git.checkPatch(target, patch)
        return patch
    } catch (error) {
        throw applyFailure("Source changes cannot be applied to the target checkout", error)
    }
}

async function applyPreparedChanges(target: string, targetHead: string, patch: Buffer): Promise<void> {
    await requireUnchangedTarget(target, targetHead)
    try {
        await git.applyPatch(target, patch)
    } catch (applyError) {
        try {
            await git.resetHard(target)
            await git.clean(target)
        } catch (rollbackError) {
            throw applyFailure(
                "Applying source changes and restoring the target both failed",
                new AggregateError([applyError, rollbackError])
            )
        }
        throw applyFailure("Applying source changes failed; the target was restored", applyError)
    }
}

async function checkoutRoot(cwd: string, role: "Source" | "Target"): Promise<string> {
    try {
        const root = await git.tryShowTopLevel(cwd)
        if (root === undefined) throw new Error(`${cwd} is not a Git worktree`)
        return await canonicalPath(root)
    } catch (error) {
        throw applyFailure(`${role} is not an available Git worktree: ${cwd}`, error)
    }
}

async function operationInProgress(cwd: string): Promise<boolean> {
    for (const marker of [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
        "rebase-apply",
        "rebase-merge",
        "sequencer"
    ]) {
        if (await exists(await git.resolveGitPath(cwd, marker))) return true
    }
    return false
}

async function changesGitLinks(cwd: string, from: string, to: string): Promise<boolean> {
    const before = await listGitLinks(cwd, from)
    const after = await listGitLinks(cwd, to)
    if (before.size !== after.size) return true
    for (const [linkPath, oid] of after) {
        if (before.get(linkPath) !== oid) return true
    }
    return false
}

async function listGitLinks(cwd: string, treeish: string): Promise<Map<string, string>> {
    const links = new Map<string, string>()
    for (const entry of await git.listTree(cwd, treeish)) {
        if (entry.type === "commit") links.set(entry.path, entry.oid)
    }
    return links
}

async function requireCleanTarget(cwd: string): Promise<void> {
    if (!(await git.isClean(cwd))) {
        throw applyFailure("Target must have no staged, unstaged, or non-ignored untracked changes")
    }
}

async function requireUnchangedTarget(cwd: string, expectedHead: string): Promise<void> {
    await requireCleanTarget(cwd)
    if ((await git.tryRevParse(cwd, "HEAD^{commit}")) !== expectedHead) {
        throw applyFailure("Target HEAD changed while the source changes were being prepared")
    }
}

function applyFailure(message: string, cause?: unknown): ClankHouseError {
    return new ClankHouseError("git_apply_changes_failed", message, cause === undefined ? undefined : { cause })
}
