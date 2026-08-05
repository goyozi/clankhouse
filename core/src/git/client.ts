import { execGit, execGitRaw, mustGit, mustGitRaw, type ProcessOutput } from "./exec"

const PATH_CHUNK_SIZE = 256

export type { ProcessOutput }

export type GitObjectId = string

export type GitRef = {
    name: string
    oid: GitObjectId
}

export type IndexEntry = {
    mode: string
    oid: GitObjectId
    stage: 0 | 1 | 2 | 3
    path: string
}

export type IndexInfoEntry = {
    mode: string
    oid: GitObjectId
    path: string
}

export type TreeEntry = {
    mode: string
    type: "blob" | "commit" | "tree"
    oid: GitObjectId
    path: string
}

export function exec(cwd: string, args: string[]): Promise<ProcessOutput> {
    return execGit(cwd, args)
}

export async function add(cwd: string, files: string[]): Promise<void> {
    await mustGit(cwd, ["add", "--", ...files])
}

export async function addAll(cwd: string, indexFile?: string): Promise<void> {
    await mustGit(cwd, ["add", "-A"], indexEnv(indexFile))
}

export async function commit(cwd: string, message: string): Promise<void> {
    await mustGit(cwd, ["commit", "-m", message])
}

export async function push(cwd: string, remote: string, source: string, destination: string): Promise<void> {
    await mustGit(cwd, ["push", remote, `${source}:${destination}`])
}

export async function resetHard(cwd: string, revision?: string): Promise<void> {
    await mustGit(cwd, ["reset", "--hard", ...(revision === undefined ? [] : [revision])])
}

export async function resetSoft(cwd: string, revision: string): Promise<void> {
    await mustGit(cwd, ["reset", "--soft", revision])
}

export async function clean(cwd: string): Promise<void> {
    await mustGit(cwd, ["clean", "-fd"])
}

export async function checkoutDetached(cwd: string, revision: string): Promise<void> {
    await mustGit(cwd, ["checkout", "--detach", "--force", revision])
}

export function revParse(cwd: string, revision: string): Promise<GitObjectId>
export function revParse(cwd: string, revisions: string[]): Promise<GitObjectId[]>
export async function revParse(cwd: string, revision: string | string[]): Promise<GitObjectId | GitObjectId[]> {
    const revisions = typeof revision === "string" ? [revision] : revision
    if (revisions.length === 0) return []
    const output = await mustGit(cwd, ["rev-parse", ...revisions])
    const oids = parseObjectIdLines("rev-parse", output.stdout, revisions.length)
    return typeof revision === "string" ? oids[0] : oids
}

export async function tryRevParse(cwd: string, revision: string): Promise<GitObjectId | undefined> {
    const output = await execGit(cwd, ["rev-parse", revision])
    if (output.exitCode !== 0) return undefined
    return parseObjectIdLines("rev-parse", output.stdout, 1)[0]
}

export async function tryShowTopLevel(cwd: string): Promise<string | undefined> {
    const output = await execGit(cwd, ["rev-parse", "--show-toplevel"])
    if (output.exitCode !== 0) return undefined
    return parseRequiredText("rev-parse --show-toplevel", output.stdout)
}

export async function resolveGitPath(cwd: string, name: string): Promise<string> {
    const output = await mustGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", name])
    return parseRequiredText("rev-parse --git-path", output.stdout)
}

export async function sharedIndexPath(cwd: string): Promise<string | undefined> {
    const output = await mustGit(cwd, ["rev-parse", "--path-format=absolute", "--shared-index-path"])
    const value = output.stdout.trim()
    return value.length === 0 ? undefined : value
}

export async function getBooleanConfig(cwd: string, key: string): Promise<boolean | undefined> {
    const output = await execGit(cwd, ["config", "--bool", "--get", key])
    if (output.exitCode !== 0) return undefined
    const value = output.stdout.trim()
    if (value === "true") return true
    if (value === "false") return false
    throw invalidOutput("config --bool", `expected true or false, received ${JSON.stringify(value)}`)
}

export async function listRefs(cwd: string, prefix: string): Promise<GitRef[]> {
    const output = await mustGit(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])
    const refs: GitRef[] = []
    for (const line of output.stdout.split("\n")) {
        if (line.length === 0) continue
        const match = /^(\S+) ([0-9a-f]+)$/.exec(line)
        if (match === null) throw invalidOutput("for-each-ref", `invalid ref record ${JSON.stringify(line)}`)
        refs.push({ name: match[1], oid: parseObjectId("for-each-ref", match[2]) })
    }
    return refs
}

export async function updateRef(
    cwd: string,
    ref: string,
    newOid: GitObjectId,
    expectedOldOid?: GitObjectId | ""
): Promise<void> {
    await mustGit(cwd, ["update-ref", ref, newOid, ...(expectedOldOid === undefined ? [] : [expectedOldOid])])
}

export async function deleteRef(cwd: string, ref: string, expectedOldOid: GitObjectId): Promise<void> {
    await mustGit(cwd, ["update-ref", "-d", ref, expectedOldOid])
}

export async function worktreeAdd(cwd: string, worktreePath: string, revision: string): Promise<void> {
    await mustGit(cwd, ["worktree", "add", "--detach", worktreePath, revision])
}

export async function worktreeRemove(cwd: string, worktreePath: string): Promise<void> {
    await mustGit(cwd, ["worktree", "remove", "--force", worktreePath])
}

export async function listWorktreePaths(cwd: string): Promise<string[]> {
    const output = await mustGit(cwd, ["worktree", "list", "--porcelain", "-z"])
    const paths: string[] = []
    for (const field of output.stdout.split("\0")) {
        if (!field.startsWith("worktree ")) continue
        const worktreePath = field.slice("worktree ".length)
        if (worktreePath.length === 0) throw invalidOutput("worktree list", "received an empty worktree path")
        paths.push(worktreePath)
    }
    return paths
}

export async function readTreeEmpty(cwd: string, indexFile: string): Promise<void> {
    await mustGit(cwd, ["read-tree", "--empty"], indexEnv(indexFile))
}

export async function normalizeIndex(cwd: string, indexFile: string): Promise<void> {
    await mustGit(
        cwd,
        ["update-index", "--no-split-index", "--no-untracked-cache", "--no-fsmonitor", "--force-write-index"],
        indexEnv(indexFile)
    )
}

export async function copyIndexEntries(cwd: string, sourceIndexFile: string, targetIndexFile: string): Promise<void> {
    const entries = await mustGitRaw(cwd, ["ls-files", "--stage", "-z"], indexEnv(sourceIndexFile))
    await readTreeEmpty(cwd, targetIndexFile)
    await mustGitRaw(cwd, ["update-index", "-z", "--index-info"], indexEnv(targetIndexFile), entries.stdout)
}

export async function listIndexEntries(cwd: string, indexFile: string): Promise<IndexEntry[]> {
    const output = await mustGit(cwd, ["ls-files", "--stage", "-z"], indexEnv(indexFile))
    const entries: IndexEntry[] = []
    for (const record of output.stdout.split("\0")) {
        if (record.length === 0) continue
        const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record)
        if (match === null) throw invalidOutput("ls-files --stage", `invalid index record ${JSON.stringify(record)}`)
        entries.push({
            mode: match[1],
            oid: parseObjectId("ls-files --stage", match[2]),
            stage: Number(match[3]) as 0 | 1 | 2 | 3,
            path: match[4]
        })
    }
    return entries
}

export async function listTrackedAndUntrackedFiles(cwd: string, indexFile: string): Promise<string[]> {
    const output = await mustGit(
        cwd,
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        indexEnv(indexFile)
    )
    return [...new Set(output.stdout.split("\0").filter((file) => file.length > 0))].sort()
}

export async function updateIndexEntries(cwd: string, indexFile: string, entries: IndexInfoEntry[]): Promise<void> {
    const input = Buffer.from(
        entries
            .map((entry) => `${entry.mode} ${entry.oid}\t${validateInputPath("update-index", entry.path)}\0`)
            .join("")
    )
    await mustGitRaw(cwd, ["update-index", "-z", "--index-info"], indexEnv(indexFile), input)
}

export async function validateIndex(cwd: string, indexFile: string): Promise<void> {
    await mustGit(cwd, ["ls-files", "--stage"], indexEnv(indexFile))
}

export async function writeTree(cwd: string, indexFile?: string): Promise<GitObjectId> {
    const output = await mustGit(cwd, ["write-tree"], indexEnv(indexFile))
    return parseObjectIdLines("write-tree", output.stdout, 1)[0]
}

export async function hashObject(cwd: string, content: Buffer): Promise<GitObjectId> {
    const output = await mustGit(cwd, ["hash-object", "-w", "--stdin"], undefined, content)
    return parseObjectIdLines("hash-object", output.stdout, 1)[0]
}

export async function hashFiles(cwd: string, files: string[]): Promise<Map<string, GitObjectId>> {
    const oids = new Map<string, GitObjectId>()
    for (let offset = 0; offset < files.length; offset += PATH_CHUNK_SIZE) {
        const chunk = files.slice(offset, offset + PATH_CHUNK_SIZE)
        const output = await mustGit(cwd, ["hash-object", "-w", "--no-filters", "--", ...chunk])
        const chunkOids = parseObjectIdLines("hash-object", output.stdout, chunk.length)
        chunk.forEach((file, index) => oids.set(file, chunkOids[index]))
    }
    return oids
}

export async function makeTree(
    cwd: string,
    entries: IndexInfoEntry[],
    options: { allowMissing?: boolean } = {}
): Promise<GitObjectId> {
    const input = Buffer.from(
        entries
            .map(
                (entry) =>
                    `${entry.mode} ${objectType(entry.mode)} ${entry.oid}\t${validateInputPath("mktree", entry.path)}\0`
            )
            .join("")
    )
    const output = await mustGit(
        cwd,
        ["mktree", "-z", ...(options.allowMissing === true ? ["--missing"] : [])],
        undefined,
        input
    )
    return parseObjectIdLines("mktree", output.stdout, 1)[0]
}

export async function commitTree(
    cwd: string,
    tree: GitObjectId,
    parent: GitObjectId,
    message: string
): Promise<GitObjectId> {
    const output = await mustGit(cwd, ["commit-tree", tree, "-p", parent, "-m", message])
    return parseObjectIdLines("commit-tree", output.stdout, 1)[0]
}

export async function listTree(cwd: string, treeish: string): Promise<TreeEntry[]> {
    const output = await mustGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", treeish])
    const entries: TreeEntry[] = []
    for (const record of output.stdout.split("\0")) {
        if (record.length === 0) continue
        const match = /^([0-7]{6}) (blob|commit|tree) ([0-9a-f]+)\t([\s\S]+)$/.exec(record)
        if (match === null) throw invalidOutput("ls-tree", `invalid tree record ${JSON.stringify(record)}`)
        entries.push({
            mode: match[1],
            type: match[2] as "blob" | "commit" | "tree",
            oid: parseObjectId("ls-tree", match[3]),
            path: match[4]
        })
    }
    return entries
}

export async function readBlob(cwd: string, object: string): Promise<Buffer> {
    return (await mustGitRaw(cwd, ["cat-file", "blob", object])).stdout
}

export async function tryReadBlob(cwd: string, object: string): Promise<Buffer | undefined> {
    const output = await execGitRaw(cwd, ["cat-file", "blob", object])
    return output.exitCode === 0 ? output.stdout : undefined
}

export async function readBlobs(cwd: string, oids: GitObjectId[]): Promise<Buffer[]> {
    if (oids.length === 0) return []
    const input = Buffer.from(`${oids.join("\n")}\n`)
    const output = (await mustGitRaw(cwd, ["cat-file", "--batch"], undefined, input)).stdout
    const blobs: Buffer[] = []
    let offset = 0
    for (const oid of oids) {
        const headerEnd = output.indexOf(0x0a, offset)
        if (headerEnd === -1) throw invalidOutput("cat-file --batch", `missing object header for ${oid}`)
        const header = output.subarray(offset, headerEnd).toString("utf8")
        const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(header)
        if (match === null) throw invalidOutput("cat-file --batch", `invalid object header for ${oid}: ${header}`)
        parseObjectId("cat-file --batch", match[1])
        const contentStart = headerEnd + 1
        const contentEnd = contentStart + Number(match[2])
        if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
            throw invalidOutput("cat-file --batch", `invalid blob content for ${oid}`)
        }
        blobs.push(output.subarray(contentStart, contentEnd))
        offset = contentEnd + 1
    }
    if (offset !== output.length) throw invalidOutput("cat-file --batch", "received trailing blob content")
    return blobs
}

function indexEnv(indexFile: string | undefined): NodeJS.ProcessEnv | undefined {
    return indexFile === undefined ? undefined : { GIT_INDEX_FILE: indexFile }
}

function parseObjectIdLines(operation: string, stdout: string, expectedCount: number): GitObjectId[] {
    const lines = stdout.trimEnd().split("\n")
    if (lines.length !== expectedCount) {
        throw invalidOutput(operation, `expected ${expectedCount} object IDs, received ${lines.length}`)
    }
    return lines.map((line) => parseObjectId(operation, line))
}

function parseObjectId(operation: string, value: string): GitObjectId {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
        throw invalidOutput(operation, `invalid object ID ${JSON.stringify(value)}`)
    }
    return value
}

function parseRequiredText(operation: string, stdout: string): string {
    const value = stdout.trim()
    if (value.length === 0) throw invalidOutput(operation, "received empty output")
    return value
}

function validateInputPath(operation: string, value: string): string {
    if (value.includes("\0")) throw new Error(`${operation} path contains a NUL byte`)
    return value
}

function objectType(mode: string): "blob" | "commit" | "tree" {
    if (mode === "040000") return "tree"
    if (mode === "160000") return "commit"
    return "blob"
}

function invalidOutput(operation: string, detail: string): Error {
    return new Error(`git ${operation} returned invalid output: ${detail}`)
}
