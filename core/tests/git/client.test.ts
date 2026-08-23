import * as path from "node:path"
import { realpath } from "node:fs/promises"
import { expect, test } from "vitest"
import { runGit, tempDir, tempGitRepo } from "@clankhouse/test-utils"
import * as git from "../../src/git/client"

test("typed revision, configuration, ref and worktree operations", async () => {
    // given a repository, a ref target and an available checkout path
    const repo = await tempGitRepo()
    const head = await runGit(repo.path, ["rev-parse", "HEAD"])
    const ref = "refs/clankhouse/client/test"
    const checkout = path.join(tempDir("clankhouse-client-worktree-"), "checkout")

    // when the client publishes the ref and adds the detached worktree
    await git.updateRef(repo.path, ref, head, "")
    await git.worktreeAdd(repo.path, checkout, head)

    // then logical queries return typed values instead of process output
    expect(await git.revParse(repo.path, "HEAD^{commit}")).toBe(head)
    expect(await git.tryShowTopLevel(checkout)).toBe(await realpath(checkout))
    expect(typeof (await git.getBooleanConfig(repo.path, "core.filemode"))).toBe("boolean")
    expect(await git.listRefs(repo.path, "refs/clankhouse/client/")).toEqual([{ name: ref, oid: head }])
    expect(
        await Promise.all((await git.listWorktreePaths(repo.path)).map((worktreePath) => realpath(worktreePath)))
    ).toEqual(expect.arrayContaining([await realpath(repo.path), await realpath(checkout)]))

    // and missing probes return undefined while compare-and-swap deletion removes the ref
    expect(await git.tryRevParse(repo.path, "refs/clankhouse/client/missing^{commit}")).toBeUndefined()
    expect(await git.getBooleanConfig(repo.path, "clankhouse.missing")).toBeUndefined()
    await git.deleteRef(repo.path, ref, head)
    expect(await git.listRefs(repo.path, "refs/clankhouse/client/")).toEqual([])
})

test("typed index and tree operations preserve NUL-delimited paths", async () => {
    // given staged files whose names require delimiter-safe parsing on the current filesystem
    const repo = await tempGitRepo()
    const files = process.platform === "win32" ? ["space name.txt"] : ["line\nbreak.txt", "space name.txt"]
    files.forEach((file) => repo.write(file, file))
    await git.add(repo.path, files)
    const sourceIndex = await git.resolveGitPath(repo.path, "index")
    const copiedIndex = path.join(tempDir("clankhouse-client-index-"), "index")

    // when the client copies and reads the index and writes its tree
    await git.copyIndexEntries(repo.path, sourceIndex, copiedIndex)
    await git.normalizeIndex(repo.path, copiedIndex)
    const indexEntries = await git.listIndexEntries(repo.path, copiedIndex)
    const workingFiles = await git.listTrackedAndUntrackedFiles(repo.path, copiedIndex)
    const tree = await git.writeTree(repo.path, copiedIndex)
    const treeEntries = await git.listTree(repo.path, tree)
    const fileOids = await git.hashFiles(repo.path, files)

    // then paths and object IDs are returned as structured values without delimiter leakage
    expect(indexEntries.map((entry) => entry.path)).toEqual(["README.md", ...files].sort())
    expect(indexEntries.every((entry) => entry.stage === 0)).toBe(true)
    expect(workingFiles).toEqual(["README.md", ...files].sort())
    expect(treeEntries.map((entry) => entry.path)).toEqual(["README.md", ...files].sort())
    expect([...fileOids.keys()]).toEqual(files)

    // and a normal index reports no shared-index path
    expect(await git.sharedIndexPath(repo.path)).toBeUndefined()
})

test("typed object operations encode trees and decode binary blobs", async () => {
    // given two binary blobs and typed tree entries
    const repo = await tempGitRepo()
    const firstContent = Buffer.from([0x00, 0x0a, 0xff])
    const secondContent = Buffer.from("second\n")
    const firstOid = await git.hashObject(repo.path, firstContent)
    const secondOid = await git.hashObject(repo.path, secondContent)
    const entries = [
        { mode: "100644", oid: firstOid, path: "blob.bin" },
        { mode: "100644", oid: secondOid, path: "line\nbreak.txt" }
    ]

    // when the client serializes a tree, commits it and reads its objects
    const tree = await git.makeTree(repo.path, entries)
    const parent = await git.revParse(repo.path, "HEAD^{commit}")
    const commit = await git.commitTree(repo.path, tree, parent, "client test")
    const treeEntries = await git.listTree(repo.path, commit)
    const blobs = await git.readBlobs(repo.path, [firstOid, secondOid])

    // then hashes, structured tree entries and exact blob bytes round-trip
    expect(await git.revParse(repo.path, `${commit}^{commit}`)).toBe(commit)
    expect(treeEntries.map(({ mode, oid, path: entryPath }) => ({ mode, oid, path: entryPath }))).toEqual(entries)
    expect(blobs).toEqual([firstContent, secondContent])
    expect(await git.readBlob(repo.path, `${commit}:blob.bin`)).toEqual(firstContent)

    // and probing an absent blob returns undefined
    expect(await git.tryReadBlob(repo.path, `${commit}:missing`)).toBeUndefined()
})
