import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    rename,
    rm,
    symlink,
    writeFile
} from "node:fs/promises"
import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import { ClankHouseError } from "../errors.js"
import { exists, isNodeError, newId } from "../util.js"
import * as git from "./client.js"

const SNAPSHOT_FORMAT = Buffer.from("clankhouse-snapshot-v1")
const RESCUE_REF_PREFIX = "refs/clankhouse/restore"
const OBJECT_CHUNK_SIZE = 64

export class Worktree {
    readonly path: string

    constructor(path: string) {
        this.path = path
    }

    async stage(files: string[]): Promise<void> {
        await git.add(this.path, files)
    }

    async commit(message: string): Promise<void> {
        await git.commit(this.path, message)
    }

    async push(upstreamBranchName: string): Promise<void> {
        await git.push(this.path, "origin", "HEAD", `refs/heads/${upstreamBranchName}`)
    }

    /**
     * Takes a snapshot of the worktree state.
     *
     * Captures the current HEAD, semantic index, and non-ignored Git-representable working files.
     * Ignored files, empty directories, filesystem metadata, submodule working directories, files outside
     * the checkout, and external side effects are excluded. The caller must prevent concurrent mutations.
     * Names are scoped to this absolute worktree path; reusing a name replaces that snapshot.
     */
    async snapshot(name: string): Promise<void> {
        validateRefSuffix(name)
        await this.snapshotRef(userSnapshotRef(this.path, name))
    }

    /**
     * Restores a worktree state snapshot.
     *
     * Replaces the current non-ignored Git-representable state.
     * The target is validated and the current state is temporarily pinned before mutation. If applying the
     * target fails, ClankHouse restores that rescue state; ignored files remain outside the restoration contract.
     * The caller must prevent concurrent mutations during the operation.
     */
    async restore(snapshotName: string): Promise<void> {
        validateRefSuffix(snapshotName)
        await restoreCapturedStateRecoverably(this.path, userSnapshotRef(this.path, snapshotName))
    }

    /** @internal */
    async snapshotRef(fullRef: string): Promise<string> {
        const state = await captureState(this.path, "clankhouse snapshot")
        await git.updateRef(this.path, fullRef, state.envelopeCommit)
        return fullRef
    }

    /** @internal */
    async restoreRef(fullRef: string): Promise<void> {
        await restoreCapturedState(this.path, fullRef)
    }

    async git(args: string[]): Promise<git.ProcessOutput> {
        return git.exec(this.path, args)
    }
}

export async function captureState(cwd: string, message: string): Promise<CapturedState> {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "clankhouse-snapshot-"))
    try {
        const head = await git.revParse(cwd, "HEAD^{commit}")
        const normalizedIndex = await copyAndNormalizeIndex(cwd, temporaryDirectory)
        const indexBytes = await readFile(normalizedIndex)
        const indexedObjects = await listIndexedObjects(cwd, normalizedIndex)
        const checkoutTree = await captureCheckoutTree(cwd, normalizedIndex, temporaryDirectory)
        const rawTree = await captureRawTree(cwd, normalizedIndex, temporaryDirectory)
        const workingCommit = await git.commitTree(cwd, checkoutTree, head, `${message} working tree`)
        const envelopeTree = await createEnvelopeTree(cwd, indexBytes, indexedObjects, rawTree)
        const envelopeCommit = await git.commitTree(cwd, envelopeTree, workingCommit, `${message} envelope`)
        return { head, workingCommit, envelopeCommit }
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true })
    }
}

export async function restoreCapturedState(cwd: string, ref: string): Promise<void> {
    const prepared = await prepareIndexRestore(cwd, ref)
    await applyPreparedState(cwd, prepared)
}

async function restoreCapturedStateRecoverably(cwd: string, ref: string): Promise<void> {
    const target = await prepareIndexRestore(cwd, ref)
    let rescue: CapturedState
    let rescueRef: string
    try {
        rescue = await captureState(cwd, "clankhouse restore rescue")
        rescueRef = `${RESCUE_REF_PREFIX}/${Date.now()}-${newId()}`
        await git.updateRef(cwd, rescueRef, rescue.envelopeCommit, "")
    } catch (error) {
        await disposePreparedState(target)
        throw error
    }

    let failure: unknown
    try {
        await applyPreparedState(cwd, target)
    } catch (targetError) {
        try {
            await restoreCapturedState(cwd, rescueRef)
            failure = targetError
        } catch (rollbackError) {
            failure = restoreFailure("Snapshot application and rescue restoration both failed", [
                targetError,
                rollbackError
            ])
        }
    }

    try {
        await git.deleteRef(cwd, rescueRef, rescue.envelopeCommit)
    } catch (cleanupError) {
        failure = restoreFailure("Snapshot restoration could not remove its rescue ref", [
            ...(failure === undefined ? [] : [failure]),
            cleanupError
        ])
    }
    if (failure !== undefined) throw failure
}

export async function removeStaleRescueRefs(cwd: string, olderThan: number): Promise<void> {
    for (const ref of await git.listRefs(cwd, `${RESCUE_REF_PREFIX}/`)) {
        const match = /^refs\/clankhouse\/restore\/([0-9]+)-[0-9A-Za-z]{21}$/.exec(ref.name)
        if (match === null || Number(match[1]) >= olderThan) continue
        await git.deleteRef(cwd, ref.name, ref.oid)
    }
}

async function applyPreparedState(cwd: string, prepared: PreparedIndexRestore): Promise<void> {
    try {
        await git.resetHard(cwd)
        await git.clean(cwd)
        await git.checkoutDetached(cwd, prepared.workingCommit)
        await git.resetSoft(cwd, prepared.head)
        await materializeRawTree(cwd, prepared.rawEntries)
        await rename(prepared.temporaryIndex, prepared.targetIndex)
    } finally {
        await disposePreparedState(prepared)
    }
}

async function disposePreparedState(prepared: PreparedIndexRestore): Promise<void> {
    await rm(prepared.temporaryDirectory, { recursive: true, force: true })
}

function restoreFailure(message: string, causes: unknown[]): ClankHouseError {
    return new ClankHouseError("git_snapshot_restore_failed", message, { cause: new AggregateError(causes, message) })
}

async function copyAndNormalizeIndex(cwd: string, temporaryDirectory: string): Promise<string> {
    const sourceIndex = await git.resolveGitPath(cwd, "index")
    const temporaryIndex = path.join(temporaryDirectory, "index")
    if (await exists(sourceIndex)) {
        await copyFile(sourceIndex, temporaryIndex)
        const sharedIndex = await git.sharedIndexPath(cwd)
        if (sharedIndex !== undefined) {
            await copyFile(sharedIndex, path.join(temporaryDirectory, path.basename(sharedIndex)))
        }
    } else {
        await git.readTreeEmpty(cwd, temporaryIndex)
    }
    await git.normalizeIndex(cwd, temporaryIndex)
    return temporaryIndex
}

async function listIndexedObjects(cwd: string, indexFile: string): Promise<IndexedObject[]> {
    const objects = new Map<string, IndexedObject>()
    for (const entry of await git.listIndexEntries(cwd, indexFile)) {
        if (/^0+$/.test(entry.oid)) continue
        objects.set(entry.oid, { mode: entry.mode, oid: entry.oid })
    }
    return [...objects.values()]
}

async function captureCheckoutTree(cwd: string, normalizedIndex: string, temporaryDirectory: string): Promise<string> {
    const checkoutIndex = path.join(temporaryDirectory, "checkout-index")
    await git.copyIndexEntries(cwd, normalizedIndex, checkoutIndex)
    await git.addAll(cwd, checkoutIndex)
    return git.writeTree(cwd, checkoutIndex)
}

async function captureRawTree(cwd: string, normalizedIndex: string, temporaryDirectory: string): Promise<string> {
    const workingIndex = path.join(temporaryDirectory, "raw-index")
    const indexedEntries = await listIndexedEntries(cwd, normalizedIndex)
    const files = await git.listTrackedAndUntrackedFiles(cwd, normalizedIndex)
    const config = await workingTreeConfig(cwd)
    const entries: PendingWorkingTreeEntry[] = []
    await git.readTreeEmpty(cwd, workingIndex)
    for (const file of files) {
        const entry = await captureWorkingTreeEntry(cwd, file, indexedEntries.get(file), config)
        if (entry !== undefined) entries.push(entry)
    }
    const fileOids = await git.hashFiles(
        cwd,
        entries.flatMap((entry) => (entry.file === undefined ? [] : [entry.file]))
    )
    const indexEntries = entries.map((entry) => {
        const oid = entry.oid ?? fileOids.get(entry.file!)
        if (oid === undefined) throw new Error(`Could not hash working-tree file: ${entry.file}`)
        return { mode: entry.mode, oid, path: entry.path }
    })
    await git.updateIndexEntries(cwd, workingIndex, indexEntries)
    return git.writeTree(cwd, workingIndex)
}

async function listIndexedEntries(cwd: string, indexFile: string): Promise<Map<string, git.IndexEntry>> {
    const entries = new Map<string, git.IndexEntry>()
    for (const entry of await git.listIndexEntries(cwd, indexFile)) {
        const existing = entries.get(entry.path)
        if (existing === undefined || entry.stage === 0 || (existing.stage !== 0 && entry.stage === 2)) {
            entries.set(entry.path, entry)
        }
    }
    return entries
}

async function captureWorkingTreeEntry(
    cwd: string,
    file: string,
    indexed: git.IndexEntry | undefined,
    config: WorkingTreeConfig
): Promise<PendingWorkingTreeEntry | undefined> {
    const target = path.join(cwd, file)
    const stats = await lstatOrUndefined(target)
    if (stats === undefined) return undefined
    if (indexed?.mode === "160000" && stats.isDirectory()) {
        return { path: file, mode: "160000", oid: await submoduleHead(target, indexed.oid) }
    }
    if (stats.isSymbolicLink() || (indexed?.mode === "120000" && !config.symlinks)) {
        const content = stats.isSymbolicLink() ? await readlink(target, { encoding: "buffer" }) : await readFile(target)
        return { path: file, mode: "120000", oid: await git.hashObject(cwd, content) }
    }
    if (!stats.isFile()) return undefined
    const executable = config.fileMode ? (stats.mode & 0o111) !== 0 : indexed?.mode === "100755"
    return { path: file, mode: executable ? "100755" : "100644", file }
}

async function submoduleHead(target: string, fallback: string): Promise<string> {
    const root = await git.tryShowTopLevel(target)
    if (root === undefined || path.resolve(root) !== path.resolve(target)) return fallback
    return (await git.tryRevParse(target, "HEAD^{commit}")) ?? fallback
}

async function workingTreeConfig(cwd: string): Promise<WorkingTreeConfig> {
    return {
        fileMode: (await git.getBooleanConfig(cwd, "core.filemode")) ?? true,
        symlinks: (await git.getBooleanConfig(cwd, "core.symlinks")) ?? true
    }
}

async function createEnvelopeTree(
    cwd: string,
    indexBytes: Buffer,
    indexedObjects: IndexedObject[],
    rawTree: string
): Promise<string> {
    const formatOid = await git.hashObject(cwd, SNAPSHOT_FORMAT)
    const indexOid = await git.hashObject(cwd, indexBytes)
    const pinnedTree = await git.makeTree(
        cwd,
        indexedObjects.map(({ mode, oid }) => ({ mode, oid, path: oid })),
        { allowMissing: true }
    )
    return git.makeTree(cwd, [
        { mode: "100644", oid: formatOid, path: "format" },
        { mode: "100644", oid: indexOid, path: "index" },
        { mode: "040000", oid: pinnedTree, path: "pinned" },
        { mode: "040000", oid: rawTree, path: "working" }
    ])
}

async function readRawTreeEntries(cwd: string, treeish: string): Promise<RawTreeEntry[]> {
    return (await git.listTree(cwd, treeish))
        .filter((entry) => entry.type === "blob")
        .map(({ mode, oid, path: entryPath }) => ({ mode, oid, path: entryPath }))
}

async function materializeRawTree(cwd: string, entries: RawTreeEntry[]): Promise<void> {
    const symlinks = (await git.getBooleanConfig(cwd, "core.symlinks")) ?? true
    for (let offset = 0; offset < entries.length; offset += OBJECT_CHUNK_SIZE) {
        const chunk = entries.slice(offset, offset + OBJECT_CHUNK_SIZE)
        const contents = await git.readBlobs(
            cwd,
            chunk.map((entry) => entry.oid)
        )
        for (let index = 0; index < chunk.length; index++) {
            await materializeRawTreeEntry(cwd, chunk[index], contents[index], symlinks)
        }
    }
}

async function materializeRawTreeEntry(
    cwd: string,
    entry: RawTreeEntry,
    content: Buffer,
    symlinks: boolean
): Promise<void> {
    const target = resolveSnapshotPath(cwd, entry.path)
    await ensureParentDirectories(cwd, entry.path)
    if (entry.mode === "120000" && symlinks) {
        await rm(target, { recursive: true, force: true })
        await symlink(content.toString("utf8"), target)
    } else {
        const stats = await lstatOrUndefined(target)
        if (stats !== undefined && !stats.isFile()) await rm(target, { recursive: true, force: true })
        await writeFile(target, content)
        await chmod(target, entry.mode === "100755" ? 0o755 : 0o644)
    }
}

async function ensureParentDirectories(cwd: string, file: string): Promise<void> {
    const parts = file.split("/").slice(0, -1)
    let current = cwd
    for (const part of parts) {
        current = path.join(current, part)
        const stats = await lstatOrUndefined(current)
        if (stats?.isDirectory()) continue
        if (stats !== undefined) await rm(current, { recursive: true, force: true })
        await mkdir(current)
    }
}

function resolveSnapshotPath(cwd: string, file: string): string {
    const root = path.resolve(cwd)
    const target = path.resolve(root, file)
    const parts = file.split("/")
    if (
        file.length === 0 ||
        path.isAbsolute(file) ||
        target === root ||
        !target.startsWith(`${root}${path.sep}`) ||
        parts.includes("..") ||
        parts.some((part) => part.toLowerCase() === ".git")
    ) {
        throw new Error(`Snapshot contains unsafe path: ${file}`)
    }
    return target
}

async function lstatOrUndefined(target: string) {
    try {
        return await lstat(target)
    } catch (error) {
        if (isNodeError(error, "ENOENT")) return undefined
        throw error
    }
}

async function prepareIndexRestore(cwd: string, ref: string): Promise<PreparedIndexRestore> {
    const commit = await git.revParse(cwd, `${ref}^{commit}`)
    const format = await git.tryReadBlob(cwd, `${commit}:format`)
    if (format === undefined || !format.equals(SNAPSHOT_FORMAT)) {
        throw new ClankHouseError(
            "git_snapshot_format_unsupported",
            `Snapshot ${ref} is not in the supported clankhouse-snapshot-v1 format`
        )
    }
    const index = await git.readBlob(cwd, `${commit}:index`)
    const workingCommit = await git.revParse(cwd, `${commit}^`)
    const head = await git.revParse(cwd, `${commit}^^`)
    const rawTree = await git.revParse(cwd, `${commit}:working`)
    await git.revParse(cwd, [`${workingCommit}^{tree}`, `${rawTree}^{tree}`])
    const rawEntries = await readRawTreeEntries(cwd, rawTree)
    for (const entry of rawEntries) resolveSnapshotPath(cwd, entry.path)
    const targetIndex = await git.resolveGitPath(cwd, "index")
    const temporaryDirectory = await mkdtemp(path.join(path.dirname(targetIndex), "clankhouse-index-restore-"))
    const temporaryIndex = path.join(temporaryDirectory, "index")
    try {
        await writeFile(temporaryIndex, index)
        await git.validateIndex(cwd, temporaryIndex)
        return { commit, workingCommit, head, rawEntries, targetIndex, temporaryDirectory, temporaryIndex }
    } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true })
        throw error
    }
}

function userSnapshotRef(worktreePath: string, name: string): string {
    const namespace = createHash("sha256").update(path.resolve(worktreePath)).digest("hex")
    return `refs/clankhouse/user/${namespace}/${name}`
}

function validateRefSuffix(name: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
        throw new ClankHouseError(
            "git_snapshot_name_invalid",
            `Invalid snapshot name "${name}"; use only letters, digits, ".", "_" and "-"`
        )
    }
}

type CapturedState = { head: string; workingCommit: string; envelopeCommit: string }

type IndexedObject = { mode: string; oid: string }

type WorkingTreeConfig = { fileMode: boolean; symlinks: boolean }

type PendingWorkingTreeEntry = {
    path: string
    mode: "100644" | "100755" | "120000" | "160000"
    oid?: string
    file?: string
}

type RawTreeEntry = { mode: string; oid: string; path: string }

type PreparedIndexRestore = {
    commit: string
    workingCommit: string
    head: string
    rawEntries: RawTreeEntry[]
    targetIndex: string
    temporaryDirectory: string
    temporaryIndex: string
}
