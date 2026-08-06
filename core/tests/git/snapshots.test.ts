import * as fs from "node:fs"
import * as path from "node:path"
import { expect, test } from "vitest"
import { GitRepository } from "@loopy/core/git"
import { runGit, tempDir, tempGitRepo } from "@loopy/test-utils"
import { createWorktree, userSnapshotRef, writeTree } from "./helpers"

test("snapshot and restore round-trip covering edits, adds and deletes", async () => {
    // given a repo with a committed file that will later be deleted
    const repo = await tempGitRepo()
    repo.write("delete-me.txt", "bye")
    await repo.commitAll("add delete-me")
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    const originalHead = await runGit(worktree.path, ["rev-parse", "HEAD"])

    // when a tracked file is edited, a new file is added and a tracked file is deleted, then snapshotted
    fs.writeFileSync(path.join(worktree.path, "README.md"), "changed")
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "new")
    fs.rmSync(path.join(worktree.path, "delete-me.txt"))
    await worktree.snapshot("snap1")

    // then the snapshot ref exists
    expect((await worktree.git(["rev-parse", userSnapshotRef(worktree, "snap1")])).exitCode).toBe(0)

    // when the worktree is hard reset and an unrelated file is added
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])
    fs.writeFileSync(path.join(worktree.path, "other.txt"), "other")

    // and when the snapshot is restored
    await worktree.restore("snap1")

    // then the edited file's content is restored
    expect(fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")).toBe("changed")
    // and the added file is restored
    expect(fs.readFileSync(path.join(worktree.path, "new.txt"), "utf8")).toBe("new")
    // and the deleted file stays deleted
    expect(fs.existsSync(path.join(worktree.path, "delete-me.txt"))).toBe(false)
    // and the unrelated file added after the snapshot is removed
    expect(fs.existsSync(path.join(worktree.path, "other.txt"))).toBe(false)
    // and HEAD is unchanged from before the snapshot
    expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(originalHead)
    // and the restored changes remain uncommitted
    expect(await runGit(worktree.path, ["status", "--porcelain"])).not.toBe("")
    // and the temporary rescue ref was removed
    expect(await runGit(worktree.path, ["for-each-ref", "--format=%(refname)", "refs/loopy/restore"])).toBe("")
})

test("restore returns to the same commit when the worktree was fully committed", async () => {
    // given a worktree with a new file committed, leaving a clean state
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "content")
    await worktree.stage(["new.txt"])
    await worktree.commit("add new.txt")
    const committedHead = await runGit(worktree.path, ["rev-parse", "HEAD"])

    // when the committed state is snapshotted
    await worktree.snapshot("committed")
    // and the worktree is dirtied afterward
    fs.writeFileSync(path.join(worktree.path, "junk.txt"), "junk")
    // and the snapshot is restored
    await worktree.restore("committed")

    // then HEAD points at the same commit as when the snapshot was taken
    expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(committedHead)
    // and there are no pending changes
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe("")
    // and the committed file is present
    expect(fs.readFileSync(path.join(worktree.path, "new.txt"), "utf8")).toBe("content")
})

test("user snapshot names are scoped per worktree and replace within one worktree", async () => {
    // given two worktrees in one repository with different states under the same snapshot name
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const first = await createWorktree(repository, { base: "main" })
    const second = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(first.path, "state.txt"), "first")
    fs.writeFileSync(path.join(second.path, "state.txt"), "second")
    await first.snapshot("shared")
    await second.snapshot("shared")
    const firstOriginalRef = await runGit(first.path, ["rev-parse", userSnapshotRef(first, "shared")])
    const secondRef = await runGit(second.path, ["rev-parse", userSnapshotRef(second, "shared")])
    fs.writeFileSync(path.join(first.path, "state.txt"), "first replacement")
    await first.snapshot("shared")
    const firstReplacementRef = await runGit(first.path, ["rev-parse", userSnapshotRef(first, "shared")])
    fs.writeFileSync(path.join(first.path, "state.txt"), "discard first")
    fs.writeFileSync(path.join(second.path, "state.txt"), "discard second")

    // when both worktrees restore the identically named snapshot
    await first.restore("shared")
    await second.restore("shared")

    // then each resolves its own namespace and the repeated first snapshot uses its latest state
    expect(firstOriginalRef).not.toBe(firstReplacementRef)
    expect(firstReplacementRef).not.toBe(secondRef)
    expect(fs.readFileSync(path.join(first.path, "state.txt"), "utf8")).toBe("first replacement")
    expect(fs.readFileSync(path.join(second.path, "state.txt"), "utf8")).toBe("second")
})

test("snapshot leaves the user's index untouched", async () => {
    // given a worktree with one staged file and one unstaged file
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "staged.txt"), "staged")
    fs.writeFileSync(path.join(worktree.path, "unstaged.txt"), "unstaged")
    await worktree.stage(["staged.txt"])
    const statusBefore = await runGit(worktree.path, ["status", "--porcelain"])

    // when a snapshot is taken
    await worktree.snapshot("snap1")

    // then the index/status is unchanged from before the snapshot
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe(statusBefore)
})

test("snapshot restore reproduces the exact staged and unstaged state", async () => {
    // given a worktree with distinct staged and unstaged changes
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "README.md"), "staged\n")
    await worktree.stage(["README.md"])
    fs.writeFileSync(path.join(worktree.path, "README.md"), "staged\nunstaged\n")
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "new")
    const statusBefore = await runGit(worktree.path, ["status", "--porcelain"])
    const cachedBefore = await runGit(worktree.path, ["diff", "--cached", "--binary"])
    const unstagedBefore = await runGit(worktree.path, ["diff", "--binary"])

    // when the state is snapshotted, replaced, and restored
    await worktree.snapshot("exact-index")
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])
    await worktree.restore("exact-index")

    // then both the index and working tree match the captured state
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe(statusBefore)
    expect(await runGit(worktree.path, ["diff", "--cached", "--binary"])).toBe(cachedBefore)
    expect(await runGit(worktree.path, ["diff", "--binary"])).toBe(unstagedBefore)
})

test("snapshot restore preserves ignored files while removing ordinary untracked files", async () => {
    // given a snapshot followed by ignored and ordinary untracked output
    const repo = await tempGitRepo()
    repo.write(".gitignore", "cache/\n")
    await repo.commitAll("ignore cache")
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    await worktree.snapshot("preserve-ignored")
    fs.mkdirSync(path.join(worktree.path, "cache"))
    fs.writeFileSync(path.join(worktree.path, "cache", "data.txt"), "cached")
    fs.writeFileSync(path.join(worktree.path, "junk.txt"), "junk")

    // when the snapshot is restored
    await worktree.restore("preserve-ignored")

    // then ignored output remains while ordinary untracked output is cleaned
    expect(fs.readFileSync(path.join(worktree.path, "cache", "data.txt"), "utf8")).toBe("cached")
    expect(fs.existsSync(path.join(worktree.path, "junk.txt"))).toBe(false)
})

test("snapshot captures a same-stat file edit after the index stops being racy", async () => {
    // given a tracked file whose same-size edit retains the indexed modification time
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    await runGit(worktree.path, ["config", "core.trustctime", "false"])
    const file = path.join(worktree.path, "racy.txt")
    const indexedTime = new Date(Date.now() + 1_000)
    fs.writeFileSync(file, "before\n")
    fs.utimesSync(file, indexedTime, indexedTime)
    await worktree.stage(["racy.txt"])
    await worktree.commit("add racy fixture")
    fs.writeFileSync(file, "change\n")
    fs.utimesSync(file, indexedTime, indexedTime)
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, indexedTime.getTime() - Date.now() + 200)))

    // when the edit is snapshotted, discarded, and restored
    await worktree.snapshot("same-stat")
    await runGit(worktree.path, ["reset", "--hard"])
    await worktree.restore("same-stat")

    // then capture hashes the current bytes instead of trusting copied index stats
    expect(fs.readFileSync(file, "utf8")).toBe("change\n")
})

test("snapshot preserves raw working bytes when a clean filter changes repository content", async () => {
    // given a tracked file whose clean filter uppercases content written to Git objects
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    const filterDirectory = tempDir("loopy-clean-filter-")
    const filterScript = path.join(filterDirectory, "uppercase.mjs")
    fs.writeFileSync(
        filterScript,
        "const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); const value = Buffer.concat(chunks).toString(); if (process.argv[2] === 'clean') process.stdout.write(value.toUpperCase()); else if (value === value.toUpperCase()) process.stdout.write(value.toLowerCase()); else process.exitCode = 1\n"
    )
    const filterCommand = (mode: string) =>
        `${JSON.stringify(process.execPath)} ${JSON.stringify(filterScript)} ${mode}`
    await runGit(worktree.path, ["config", "filter.upper.clean", filterCommand("clean")])
    await runGit(worktree.path, ["config", "filter.upper.smudge", filterCommand("smudge")])
    fs.writeFileSync(path.join(worktree.path, ".gitattributes"), "filtered.txt filter=upper\n")
    const file = path.join(worktree.path, "filtered.txt")
    fs.writeFileSync(file, "BASE\n")
    await worktree.stage([".gitattributes", "filtered.txt"])
    await worktree.commit("add filtered fixture")
    fs.writeFileSync(file, "lower\n")

    // when the working file is snapshotted, discarded, and restored
    await worktree.snapshot("raw-filtered")
    await runGit(worktree.path, ["reset", "--hard"])
    await worktree.restore("raw-filtered")

    // then restoration writes the captured working bytes without clean or smudge filters
    expect(fs.readFileSync(file, "utf8")).toBe("lower\n")
})

test("snapshot stores a v1 envelope with its working parent, raw index and pinned objects", async () => {
    // given a staged-only blob followed by different working-tree content
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "staged-only.txt"), "staged\n")
    await worktree.stage(["staged-only.txt"])
    const stagedOid = await runGit(worktree.path, ["rev-parse", ":staged-only.txt"])
    fs.writeFileSync(path.join(worktree.path, "staged-only.txt"), "working\n")
    const originalHead = await runGit(worktree.path, ["rev-parse", "HEAD"])

    // when the state is snapshotted
    await worktree.snapshot("envelope")

    // then the ref points at the expected versioned envelope and parent chain
    const ref = userSnapshotRef(worktree, "envelope")
    expect(await runGit(worktree.path, ["show", `${ref}:format`])).toBe("loopy-snapshot-v1")
    expect(await runGit(worktree.path, ["cat-file", "-t", `${ref}:index`])).toBe("blob")
    expect(await runGit(worktree.path, ["rev-parse", `${ref}^^`])).toBe(originalHead)
    expect(await runGit(worktree.path, ["show", `${ref}^:staged-only.txt`])).toBe("working")
    // and the staged-only object is reachable through the pinned tree
    expect(await runGit(worktree.path, ["cat-file", "-t", `${ref}:pinned/${stagedOid}`])).toBe("blob")
})

test("snapshot normalizes a split index while preserving extended flags and actual working bytes", async () => {
    // given a split index with intent-to-add, assume-unchanged and skip-worktree entries
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "assume.txt"), "base\n")
    fs.writeFileSync(path.join(worktree.path, "skip.txt"), "base\n")
    await worktree.stage(["assume.txt", "skip.txt"])
    await worktree.commit("add index flag fixtures")
    fs.writeFileSync(path.join(worktree.path, "intent.txt"), "intent\n")
    await runGit(worktree.path, ["add", "-N", "intent.txt"])
    await runGit(worktree.path, ["update-index", "--assume-unchanged", "assume.txt"])
    await runGit(worktree.path, ["update-index", "--skip-worktree", "skip.txt"])
    fs.writeFileSync(path.join(worktree.path, "assume.txt"), "assume working\n")
    fs.writeFileSync(path.join(worktree.path, "skip.txt"), "skip working\n")
    await runGit(worktree.path, ["update-index", "--split-index"])
    const stagesBefore = await runGit(worktree.path, ["ls-files", "--stage"])
    const tagsBefore = await runGit(worktree.path, ["ls-files", "-v"])
    const statusBefore = await runGit(worktree.path, ["status", "--porcelain=v2"])

    // when the snapshot is captured, the checkout is replaced, and the snapshot is restored
    await worktree.snapshot("extended-index")
    await runGit(worktree.path, ["update-index", "--no-assume-unchanged", "assume.txt"])
    await runGit(worktree.path, ["update-index", "--no-skip-worktree", "skip.txt"])
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])
    await worktree.restore("extended-index")

    // then all semantic entries and flags survive in a self-contained index
    expect(await runGit(worktree.path, ["ls-files", "--stage"])).toBe(stagesBefore)
    expect(await runGit(worktree.path, ["ls-files", "-v"])).toBe(tagsBefore)
    expect(await runGit(worktree.path, ["status", "--porcelain=v2"])).toBe(statusBefore)
    expect(await runGit(worktree.path, ["rev-parse", "--shared-index-path"])).toBe("")
    // and files hidden by performance flags retain their captured working content
    expect(fs.readFileSync(path.join(worktree.path, "assume.txt"), "utf8")).toBe("assume working\n")
    expect(fs.readFileSync(path.join(worktree.path, "skip.txt"), "utf8")).toBe("skip working\n")
})

test("snapshot round-trips an unresolved index and its conflict working file", async () => {
    // given an included worktree with unresolved conflict stages
    const repo = await tempGitRepo()
    await runGit(repo.path, ["switch", "-c", "other"])
    repo.write("README.md", "other\n")
    await repo.commitAll("other change")
    await runGit(repo.path, ["switch", "main"])
    repo.write("README.md", "main\n")
    await repo.commitAll("main change")
    await expect(runGit(repo.path, ["merge", "other"])).rejects.toThrow()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { includeUncommitted: true })
    const stagesBefore = await runGit(worktree.path, ["ls-files", "--stage"])
    const conflictBefore = fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")

    // when the conflict is snapshotted, discarded, and restored
    await worktree.snapshot("unmerged")
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])
    await worktree.restore("unmerged")

    // then every conflict stage and the working conflict markers return
    expect(await runGit(worktree.path, ["ls-files", "--stage"])).toBe(stagesBefore)
    expect(fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")).toBe(conflictBefore)
})

test("snapshot pins staged-only blobs through aggressive Git garbage collection", async () => {
    // given a snapshot whose staged content differs from its working content
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "staged\n")
    await worktree.stage(["new.txt"])
    const stagedOid = await runGit(worktree.path, ["rev-parse", ":new.txt"])
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "working\n")
    const cachedBefore = await runGit(worktree.path, ["diff", "--cached", "--binary"])
    const unstagedBefore = await runGit(worktree.path, ["diff", "--binary"])
    await worktree.snapshot("gc-safe")
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])

    // when reflogs expire and unreachable objects are pruned immediately
    await runGit(worktree.path, ["reflog", "expire", "--expire=now", "--all"])
    await runGit(worktree.path, ["gc", "--prune=now"])

    // then the pinned staged blob remains and the exact state is restorable
    expect(await runGit(worktree.path, ["cat-file", "-t", stagedOid])).toBe("blob")
    await worktree.restore("gc-safe")
    expect(await runGit(worktree.path, ["diff", "--cached", "--binary"])).toBe(cachedBefore)
    expect(await runGit(worktree.path, ["diff", "--binary"])).toBe(unstagedBefore)
})

test("snapshot rejects invalid ref names", async () => {
    // given a worktree
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })

    // when snapshotting with a name containing a space
    // then it rejects with an invalid snapshot name error
    await expect(worktree.snapshot("bad name")).rejects.toMatchObject({
        message: expect.stringMatching(/Invalid snapshot name/),
        code: "git_snapshot_name_invalid"
    })
    // and when snapshotting with a name containing ".."
    // then it also rejects with an invalid snapshot name error
    await expect(worktree.snapshot("bad..name")).rejects.toMatchObject({
        message: expect.stringMatching(/Invalid snapshot name/),
        code: "git_snapshot_name_invalid"
    })
})

test("restore rejects an unsupported snapshot before modifying the checkout", async () => {
    // given a snapshot ref pointing at an ordinary commit and a dirty checkout
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    await runGit(worktree.path, ["update-ref", userSnapshotRef(worktree, "unsupported"), "HEAD"])
    fs.writeFileSync(path.join(worktree.path, "keep.txt"), "keep")
    const headBefore = await runGit(worktree.path, ["rev-parse", "HEAD"])

    // when restoration validates the unsupported ref
    const restore = worktree.restore("unsupported")

    // then it fails before resetting either HEAD or the working tree
    await expect(restore).rejects.toMatchObject({ code: "git_snapshot_format_unsupported" })
    expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(headBefore)
    expect(fs.readFileSync(path.join(worktree.path, "keep.txt"), "utf8")).toBe("keep")
    // and validation did not publish a rescue ref
    expect(await runGit(worktree.path, ["for-each-ref", "--format=%(refname)", "refs/loopy/restore"])).toBe("")
})

test("restore rolls back the prior state when target materialization fails", async () => {
    // given a structurally valid snapshot whose symlink bytes cannot be materialized
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    await runGit(worktree.path, ["config", "core.symlinks", "true"])
    await worktree.snapshot("broken")
    const ref = userSnapshotRef(worktree, "broken")
    const invalidTarget = path.join(tempDir("loopy-invalid-symlink-"), "target")
    fs.writeFileSync(invalidTarget, Buffer.from([0]))
    const invalidTargetOid = await runGit(worktree.path, ["hash-object", "-w", invalidTarget])
    const rawTree = await writeTree(worktree, [{ mode: "120000", oid: invalidTargetOid, path: "bad-link" }])
    const envelopeTree = await writeTree(worktree, [
        { mode: "100644", oid: await runGit(worktree.path, ["rev-parse", `${ref}:format`]), path: "format" },
        { mode: "100644", oid: await runGit(worktree.path, ["rev-parse", `${ref}:index`]), path: "index" },
        { mode: "040000", oid: await runGit(worktree.path, ["rev-parse", `${ref}:pinned`]), path: "pinned" },
        { mode: "040000", oid: rawTree, path: "working" }
    ])
    const brokenEnvelope = await runGit(worktree.path, [
        "commit-tree",
        envelopeTree,
        "-p",
        await runGit(worktree.path, ["rev-parse", `${ref}^`]),
        "-m",
        "broken envelope"
    ])
    await runGit(worktree.path, ["update-ref", ref, brokenEnvelope])
    fs.writeFileSync(path.join(worktree.path, "README.md"), "staged\n")
    await worktree.stage(["README.md"])
    fs.writeFileSync(path.join(worktree.path, "README.md"), "staged\nunstaged\n")
    fs.writeFileSync(path.join(worktree.path, "current.txt"), "current")
    const headBefore = await runGit(worktree.path, ["rev-parse", "HEAD"])
    const statusBefore = await runGit(worktree.path, ["status", "--porcelain"])
    const cachedBefore = await runGit(worktree.path, ["diff", "--cached", "--binary"])
    const unstagedBefore = await runGit(worktree.path, ["diff", "--binary"])

    // when restoration fails after replacing the checkout
    const restore = worktree.restore("broken")

    // then the rescue snapshot restores the prior HEAD, index and working files
    await expect(restore).rejects.toThrow()
    expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(headBefore)
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe(statusBefore)
    expect(await runGit(worktree.path, ["diff", "--cached", "--binary"])).toBe(cachedBefore)
    expect(await runGit(worktree.path, ["diff", "--binary"])).toBe(unstagedBefore)
    expect(fs.readFileSync(path.join(worktree.path, "current.txt"), "utf8")).toBe("current")
    // and no rescue ref remains
    expect(await runGit(worktree.path, ["for-each-ref", "--format=%(refname)", "refs/loopy/restore"])).toBe("")
})
