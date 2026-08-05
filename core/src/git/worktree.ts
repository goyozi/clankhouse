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
import { LoopyError } from "../errors"
import { exists, isNodeError, newId } from "../util"
import { execGit, execGitRaw, mustGit, mustGitRaw, type ProcessOutput } from "./exec"

const SNAPSHOT_FORMAT = Buffer.from("loopy-snapshot-v1")
const RESCUE_REF_PREFIX = "refs/loopy/restore"
const PATH_CHUNK_SIZE = 256
const OBJECT_CHUNK_SIZE = 64

export class Worktree {
    readonly path: string

    constructor(path: string) {
        this.path = path
    }

    async stage(files: string[]): Promise<void> {
        await mustGit(this.path, ["add", "--", ...files])
    }

    async commit(message: string): Promise<void> {
        await mustGit(this.path, ["commit", "-m", message])
    }

    async push(upstreamBranchName: string): Promise<void> {
        await mustGit(this.path, ["push", "origin", `HEAD:refs/heads/${upstreamBranchName}`])
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
     * target fails, Loopy restores that rescue state; ignored files remain outside the restoration contract.
     * The caller must prevent concurrent mutations during the operation.
     */
    async restore(snapshotName: string): Promise<void> {
        validateRefSuffix(snapshotName)
        await restoreCapturedStateRecoverably(this.path, userSnapshotRef(this.path, snapshotName))
    }

    /** @internal */
    async snapshotRef(fullRef: string): Promise<string> {
        const state = await captureState(this.path, "loopy snapshot")
        await mustGit(this.path, ["update-ref", fullRef, state.envelopeCommit])
        return fullRef
    }

    /** @internal */
    async restoreRef(fullRef: string): Promise<void> {
        await restoreCapturedState(this.path, fullRef)
    }

    async git(args: string[]): Promise<ProcessOutput> {
        return execGit(this.path, args)
    }
}

export async function captureState(cwd: string, message: string): Promise<CapturedState> {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "loopy-snapshot-"))
    try {
        const head = (await mustGit(cwd, ["rev-parse", "HEAD^{commit}"])).stdout.trim()
        const normalizedIndex = await copyAndNormalizeIndex(cwd, temporaryDirectory)
        const indexBytes = await readFile(normalizedIndex)
        const indexedObjects = await listIndexedObjects(cwd, normalizedIndex)
        const checkoutTree = await captureCheckoutTree(cwd, normalizedIndex, temporaryDirectory)
        const rawTree = await captureRawTree(cwd, normalizedIndex, temporaryDirectory)
        const workingCommit = await commitTree(cwd, checkoutTree, head, `${message} working tree`)
        const envelopeTree = await createEnvelopeTree(cwd, indexBytes, indexedObjects, rawTree)
        const envelopeCommit = await commitTree(cwd, envelopeTree, workingCommit, `${message} envelope`)
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
        rescue = await captureState(cwd, "loopy restore rescue")
        rescueRef = `${RESCUE_REF_PREFIX}/${Date.now()}-${newId()}`
        await mustGit(cwd, ["update-ref", rescueRef, rescue.envelopeCommit, ""])
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
        await mustGit(cwd, ["update-ref", "-d", rescueRef, rescue.envelopeCommit])
    } catch (cleanupError) {
        failure = restoreFailure("Snapshot restoration could not remove its rescue ref", [
            ...(failure === undefined ? [] : [failure]),
            cleanupError
        ])
    }
    if (failure !== undefined) throw failure
}

export async function removeStaleRescueRefs(cwd: string, olderThan: number): Promise<void> {
    const output = await mustGit(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", `${RESCUE_REF_PREFIX}/`])
    for (const line of output.stdout.split("\n")) {
        const match = /^refs\/loopy\/restore\/([0-9]+)-[0-9A-Za-z]{21} ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(line)
        if (match === null || Number(match[1]) >= olderThan) continue
        await mustGit(cwd, ["update-ref", "-d", line.slice(0, line.indexOf(" ")), match[2]])
    }
}

async function applyPreparedState(cwd: string, prepared: PreparedIndexRestore): Promise<void> {
    try {
        await mustGit(cwd, ["reset", "--hard"])
        await mustGit(cwd, ["clean", "-fd"])
        await mustGit(cwd, ["checkout", "--detach", "--force", prepared.workingCommit])
        await mustGit(cwd, ["reset", "--soft", prepared.head])
        await materializeRawTree(cwd, prepared.rawEntries)
        await rename(prepared.temporaryIndex, prepared.targetIndex)
    } finally {
        await disposePreparedState(prepared)
    }
}

async function disposePreparedState(prepared: PreparedIndexRestore): Promise<void> {
    await rm(prepared.temporaryDirectory, { recursive: true, force: true })
}

function restoreFailure(message: string, causes: unknown[]): LoopyError {
    return new LoopyError("git_snapshot_restore_failed", message, { cause: new AggregateError(causes, message) })
}

async function copyAndNormalizeIndex(cwd: string, temporaryDirectory: string): Promise<string> {
    const sourceIndex = (
        await mustGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
    ).stdout.trim()
    const temporaryIndex = path.join(temporaryDirectory, "index")
    const env = { GIT_INDEX_FILE: temporaryIndex }
    if (await exists(sourceIndex)) {
        await copyFile(sourceIndex, temporaryIndex)
        const sharedIndex = (
            await mustGit(cwd, ["rev-parse", "--path-format=absolute", "--shared-index-path"])
        ).stdout.trim()
        if (sharedIndex.length > 0) {
            await copyFile(sharedIndex, path.join(temporaryDirectory, path.basename(sharedIndex)))
        }
    } else {
        await mustGit(cwd, ["read-tree", "--empty"], env)
    }
    await mustGit(
        cwd,
        ["update-index", "--no-split-index", "--no-untracked-cache", "--no-fsmonitor", "--force-write-index"],
        env
    )
    return temporaryIndex
}

async function listIndexedObjects(cwd: string, indexFile: string): Promise<IndexedObject[]> {
    const output = await mustGit(cwd, ["ls-files", "--stage", "-z"], { GIT_INDEX_FILE: indexFile })
    const objects = new Map<string, IndexedObject>()
    for (const entry of output.stdout.split("\0")) {
        const match = /^([0-7]{6}) ([0-9a-f]+) [0-3]\t/.exec(entry)
        if (match === null || /^0+$/.test(match[2])) continue
        objects.set(match[2], { mode: match[1], oid: match[2] })
    }
    return [...objects.values()]
}

async function captureCheckoutTree(cwd: string, normalizedIndex: string, temporaryDirectory: string): Promise<string> {
    const checkoutIndex = path.join(temporaryDirectory, "checkout-index")
    const sourceEnv = { GIT_INDEX_FILE: normalizedIndex }
    const env = { GIT_INDEX_FILE: checkoutIndex }
    const entries = await mustGitRaw(cwd, ["ls-files", "--stage", "-z"], sourceEnv)
    await mustGit(cwd, ["read-tree", "--empty"], env)
    await mustGitRaw(cwd, ["update-index", "-z", "--index-info"], env, entries.stdout)
    await mustGit(cwd, ["add", "-A"], env)
    return (await mustGit(cwd, ["write-tree"], env)).stdout.trim()
}

async function captureRawTree(cwd: string, normalizedIndex: string, temporaryDirectory: string): Promise<string> {
    const workingIndex = path.join(temporaryDirectory, "raw-index")
    const env = { GIT_INDEX_FILE: workingIndex }
    const indexedEntries = await listIndexedEntries(cwd, normalizedIndex)
    const files = await listWorkingTreeFiles(cwd, normalizedIndex)
    const config = await workingTreeConfig(cwd)
    const entries: PendingWorkingTreeEntry[] = []
    await mustGit(cwd, ["read-tree", "--empty"], env)
    for (const file of files) {
        const entry = await captureWorkingTreeEntry(cwd, file, indexedEntries.get(file), config)
        if (entry !== undefined) entries.push(entry)
    }
    const fileOids = await hashWorkingTreeFiles(
        cwd,
        entries.flatMap((entry) => (entry.file === undefined ? [] : [entry.file]))
    )
    const indexEntries = entries.map((entry) => {
        const oid = entry.oid ?? fileOids.get(entry.file!)
        if (oid === undefined) throw new Error(`Could not hash working-tree file: ${entry.file}`)
        return Buffer.from(`${entry.mode} ${oid}\t${entry.path}\0`)
    })
    await mustGitRaw(cwd, ["update-index", "-z", "--index-info"], env, Buffer.concat(indexEntries))
    return (await mustGit(cwd, ["write-tree"], env)).stdout.trim()
}

async function listIndexedEntries(cwd: string, indexFile: string): Promise<Map<string, IndexedEntry>> {
    const output = await mustGit(cwd, ["ls-files", "--stage", "-z"], { GIT_INDEX_FILE: indexFile })
    const entries = new Map<string, IndexedEntry>()
    for (const record of output.stdout.split("\0")) {
        const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record)
        if (match === null) continue
        const entry = { mode: match[1], oid: match[2], stage: Number(match[3]) }
        const existing = entries.get(match[4])
        if (existing === undefined || entry.stage === 0 || (existing.stage !== 0 && entry.stage === 2)) {
            entries.set(match[4], entry)
        }
    }
    return entries
}

async function listWorkingTreeFiles(cwd: string, indexFile: string): Promise<string[]> {
    const output = await mustGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        GIT_INDEX_FILE: indexFile
    })
    return [...new Set(output.stdout.split("\0").filter((file) => file.length > 0))].sort()
}

async function captureWorkingTreeEntry(
    cwd: string,
    file: string,
    indexed: IndexedEntry | undefined,
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
        return { path: file, mode: "120000", oid: await hashObject(cwd, content) }
    }
    if (!stats.isFile()) return undefined
    const executable = config.fileMode ? (stats.mode & 0o111) !== 0 : indexed?.mode === "100755"
    return { path: file, mode: executable ? "100755" : "100644", file }
}

async function hashWorkingTreeFiles(cwd: string, files: string[]): Promise<Map<string, string>> {
    const oids = new Map<string, string>()
    for (let offset = 0; offset < files.length; offset += PATH_CHUNK_SIZE) {
        const chunk = files.slice(offset, offset + PATH_CHUNK_SIZE)
        const output = await mustGit(cwd, ["hash-object", "-w", "--no-filters", "--", ...chunk])
        const chunkOids = output.stdout.trimEnd().split("\n")
        if (chunkOids.length !== chunk.length) throw new Error("Git returned an unexpected number of object IDs")
        chunk.forEach((file, index) => oids.set(file, chunkOids[index]))
    }
    return oids
}

async function submoduleHead(target: string, fallback: string): Promise<string> {
    const root = await execGit(target, ["rev-parse", "--show-toplevel"])
    if (root.exitCode !== 0 || path.resolve(root.stdout.trim()) !== path.resolve(target)) return fallback
    const head = await execGit(target, ["rev-parse", "HEAD^{commit}"])
    return head.exitCode === 0 ? head.stdout.trim() : fallback
}

async function workingTreeConfig(cwd: string): Promise<WorkingTreeConfig> {
    return {
        fileMode: await gitBoolean(cwd, "core.filemode", true),
        symlinks: await gitBoolean(cwd, "core.symlinks", true)
    }
}

async function gitBoolean(cwd: string, key: string, fallback: boolean): Promise<boolean> {
    const result = await execGit(cwd, ["config", "--bool", "--get", key])
    if (result.exitCode !== 0) return fallback
    return result.stdout.trim() === "true"
}

async function createEnvelopeTree(
    cwd: string,
    indexBytes: Buffer,
    indexedObjects: IndexedObject[],
    rawTree: string
): Promise<string> {
    const formatOid = await hashObject(cwd, SNAPSHOT_FORMAT)
    const indexOid = await hashObject(cwd, indexBytes)
    const pinnedInput = Buffer.from(
        indexedObjects.map(({ mode, oid }) => `${mode} ${objectType(mode)} ${oid}\t${oid}\0`).join("")
    )
    const pinnedTree = (await mustGit(cwd, ["mktree", "-z", "--missing"], undefined, pinnedInput)).stdout.trim()
    const envelopeInput = Buffer.from(
        [
            `100644 blob ${formatOid}\tformat\0`,
            `100644 blob ${indexOid}\tindex\0`,
            `040000 tree ${pinnedTree}\tpinned\0`,
            `040000 tree ${rawTree}\tworking\0`
        ].join("")
    )
    return (await mustGit(cwd, ["mktree", "-z"], undefined, envelopeInput)).stdout.trim()
}

function objectType(mode: string): "blob" | "commit" | "tree" {
    if (mode === "040000") return "tree"
    if (mode === "160000") return "commit"
    return "blob"
}

async function hashObject(cwd: string, content: Buffer): Promise<string> {
    return (await mustGit(cwd, ["hash-object", "-w", "--stdin"], undefined, content)).stdout.trim()
}

async function commitTree(cwd: string, tree: string, parent: string, message: string): Promise<string> {
    return (await mustGit(cwd, ["commit-tree", tree, "-p", parent, "-m", message])).stdout.trim()
}

async function readRawTreeEntries(cwd: string, treeish: string): Promise<RawTreeEntry[]> {
    const output = await mustGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", treeish])
    const entries: RawTreeEntry[] = []
    for (const record of output.stdout.split("\0")) {
        if (record.length === 0) continue
        const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record)
        if (match === null) throw new Error(`Snapshot contains an invalid tree entry: ${record}`)
        if (match[2] === "blob") entries.push({ mode: match[1], oid: match[3], path: match[4] })
    }
    return entries
}

async function materializeRawTree(cwd: string, entries: RawTreeEntry[]): Promise<void> {
    const symlinks = await gitBoolean(cwd, "core.symlinks", true)
    for (let offset = 0; offset < entries.length; offset += OBJECT_CHUNK_SIZE) {
        const chunk = entries.slice(offset, offset + OBJECT_CHUNK_SIZE)
        const contents = await readBlobs(
            cwd,
            chunk.map((entry) => entry.oid)
        )
        for (let index = 0; index < chunk.length; index++) {
            await materializeRawTreeEntry(cwd, chunk[index], contents[index], symlinks)
        }
    }
}

async function readBlobs(cwd: string, oids: string[]): Promise<Buffer[]> {
    const input = Buffer.from(`${oids.join("\n")}\n`)
    const output = (await mustGitRaw(cwd, ["cat-file", "--batch"], undefined, input)).stdout
    const blobs: Buffer[] = []
    let offset = 0
    for (const oid of oids) {
        const headerEnd = output.indexOf(0x0a, offset)
        if (headerEnd === -1) throw new Error(`Git returned an invalid object header for ${oid}`)
        const header = output.subarray(offset, headerEnd).toString("utf8")
        const match = /^[0-9a-f]+ blob ([0-9]+)$/.exec(header)
        if (match === null) throw new Error(`Git returned an invalid blob header for ${oid}: ${header}`)
        const contentStart = headerEnd + 1
        const contentEnd = contentStart + Number(match[1])
        if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
            throw new Error(`Git returned invalid blob content for ${oid}`)
        }
        blobs.push(output.subarray(contentStart, contentEnd))
        offset = contentEnd + 1
    }
    if (offset !== output.length) throw new Error("Git returned unexpected trailing blob content")
    return blobs
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
    const commit = (await mustGit(cwd, ["rev-parse", `${ref}^{commit}`])).stdout.trim()
    const format = await execGitRaw(cwd, ["cat-file", "blob", `${commit}:format`])
    if (format.exitCode !== 0 || !format.stdout.equals(SNAPSHOT_FORMAT)) {
        throw new LoopyError(
            "git_snapshot_format_unsupported",
            `Snapshot ${ref} is not in the supported loopy-snapshot-v1 format`
        )
    }
    const index = await mustGitRaw(cwd, ["cat-file", "blob", `${commit}:index`])
    const workingCommit = (await mustGit(cwd, ["rev-parse", `${commit}^`])).stdout.trim()
    const head = (await mustGit(cwd, ["rev-parse", `${commit}^^`])).stdout.trim()
    const rawTree = (await mustGit(cwd, ["rev-parse", `${commit}:working`])).stdout.trim()
    await mustGit(cwd, ["rev-parse", `${workingCommit}^{tree}`, `${rawTree}^{tree}`])
    const rawEntries = await readRawTreeEntries(cwd, rawTree)
    for (const entry of rawEntries) resolveSnapshotPath(cwd, entry.path)
    const targetIndex = (
        await mustGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
    ).stdout.trim()
    const temporaryDirectory = await mkdtemp(path.join(path.dirname(targetIndex), "loopy-index-restore-"))
    const temporaryIndex = path.join(temporaryDirectory, "index")
    try {
        await writeFile(temporaryIndex, index.stdout)
        await mustGit(cwd, ["ls-files", "--stage"], { GIT_INDEX_FILE: temporaryIndex })
        return { commit, workingCommit, head, rawEntries, targetIndex, temporaryDirectory, temporaryIndex }
    } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true })
        throw error
    }
}

function userSnapshotRef(worktreePath: string, name: string): string {
    const namespace = createHash("sha256").update(path.resolve(worktreePath)).digest("hex")
    return `refs/loopy/user/${namespace}/${name}`
}

function validateRefSuffix(name: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
        throw new LoopyError(
            "git_snapshot_name_invalid",
            `Invalid snapshot name "${name}"; use only letters, digits, ".", "_" and "-"`
        )
    }
}

type CapturedState = { head: string; workingCommit: string; envelopeCommit: string }

type IndexedObject = { mode: string; oid: string }

type IndexedEntry = { mode: string; oid: string; stage: number }

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
