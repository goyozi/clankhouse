import * as fs from "node:fs"
import * as path from "node:path"
import { expect, test } from "vitest"
import { GitRepository, Worktree } from "@loopy/core/git"
import { runGit, tempGitRepo } from "@loopy/test-utils"
import { createWorktree } from "./helpers"

test("applyChanges transfers the complete effective worktree state as uncommitted target changes", async () => {
    // given a clean target and a worktree containing committed, staged, unstaged and untracked changes
    const repo = await tempGitRepo()
    repo.write("delete-me.txt", "delete me\n")
    repo.write("executable.sh", "#!/bin/sh\necho old\n")
    await repo.commitAll("add transfer fixtures")
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "committed.txt"), "committed source work\n")
    await worktree.stage(["committed.txt"])
    await worktree.commit("source commit")
    fs.writeFileSync(path.join(worktree.path, "README.md"), "unstaged source edit\n")
    fs.writeFileSync(path.join(worktree.path, "staged.txt"), "staged source edit\n")
    await worktree.stage(["staged.txt"])
    fs.writeFileSync(path.join(worktree.path, "untracked.txt"), "untracked source edit\n")
    fs.writeFileSync(path.join(worktree.path, "binary.bin"), Buffer.from([0, 1, 2, 255]))
    fs.writeFileSync(path.join(worktree.path, "executable.sh"), "#!/bin/sh\necho new\n")
    fs.chmodSync(path.join(worktree.path, "executable.sh"), 0o755)
    fs.rmSync(path.join(worktree.path, "delete-me.txt"))
    fs.symlinkSync("README.md", path.join(worktree.path, "readme-link"))
    const sourceHeadBefore = await runGit(worktree.path, ["rev-parse", "HEAD"])
    const sourceStatusBefore = await runGit(worktree.path, ["status", "--porcelain"])
    const sourceIndexBefore = await runGit(worktree.path, ["write-tree"])
    const targetHeadBefore = await runGit(repo.path, ["rev-parse", "HEAD"])
    const targetBranchBefore = await runGit(repo.path, ["symbolic-ref", "HEAD"])
    const targetIndexBefore = await runGit(repo.path, ["write-tree"])
    const refsBefore = await runGit(repo.path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/loopy"])

    // when the worktree changes are applied to the target repository
    await repository.applyChanges(worktree)

    // then committed and working source content is present in the target checkout
    expect(repo.read("committed.txt")).toBe("committed source work\n")
    expect(repo.read("README.md")).toBe("unstaged source edit\n")
    expect(repo.read("staged.txt")).toBe("staged source edit\n")
    expect(repo.read("untracked.txt")).toBe("untracked source edit\n")
    expect(fs.readFileSync(path.join(repo.path, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(repo.exists("delete-me.txt")).toBe(false)
    expect(fs.readlinkSync(path.join(repo.path, "readme-link"))).toBe("README.md")
    expect(fs.statSync(path.join(repo.path, "executable.sh")).mode & 0o111).not.toBe(0)
    // and the target branch, HEAD and index are unchanged so every transferred change is uncommitted
    expect(await runGit(repo.path, ["symbolic-ref", "HEAD"])).toBe(targetBranchBefore)
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(targetHeadBefore)
    expect(await runGit(repo.path, ["write-tree"])).toBe(targetIndexBefore)
    expect(await runGit(repo.path, ["diff", "--cached", "--binary"])).toBe("")
    expect(await runGit(repo.path, ["status", "--porcelain"])).toContain("?? committed.txt")
    expect(await runGit(repo.path, ["diff", "--name-only"])).toContain("README.md")
    // and the source state and Loopy refs are unchanged
    expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(sourceHeadBefore)
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe(sourceStatusBefore)
    expect(await runGit(worktree.path, ["write-tree"])).toBe(sourceIndexBefore)
    expect(await runGit(repo.path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/loopy"])).toBe(
        refsBefore
    )
})

test("applyChanges merges source changes with independent target commits", async () => {
    // given source changes and a clean target that advanced independently
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "README.md"), "source edit\n")
    repo.write("target-only.txt", "target commit\n")
    await repo.commitAll("advance target")
    const targetHead = await runGit(repo.path, ["rev-parse", "HEAD"])

    // when the worktree changes are applied
    await repository.applyChanges(worktree)

    // then both histories' effective content is retained without moving target HEAD
    expect(repo.read("README.md")).toBe("source edit\n")
    expect(repo.read("target-only.txt")).toBe("target commit\n")
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(targetHead)
    expect(await runGit(repo.path, ["diff", "--cached"])).toBe("")
})

test("applyChanges preserves ignored files and excludes ignored source files", async () => {
    // given source and target ignored files beside one transferable source file
    const repo = await tempGitRepo()
    repo.write(".gitignore", "cache/\n")
    await repo.commitAll("ignore cache")
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.mkdirSync(path.join(worktree.path, "cache"))
    fs.writeFileSync(path.join(worktree.path, "cache", "source-only.txt"), "ignored source\n")
    fs.writeFileSync(path.join(worktree.path, "source.txt"), "source change\n")
    fs.mkdirSync(path.join(repo.path, "cache"))
    fs.writeFileSync(path.join(repo.path, "cache", "target-only.txt"), "ignored target\n")

    // when the source changes are applied
    await repository.applyChanges(worktree)

    // then the target ignored file survives and the source ignored file is not transferred
    expect(repo.read("cache/target-only.txt")).toBe("ignored target\n")
    expect(repo.exists("cache/source-only.txt")).toBe(false)
    expect(repo.read("source.txt")).toBe("source change\n")
})

test("applyChanges is a no-op for equal states and remains stateless across previews", async () => {
    // given a clean equal worktree state
    const repo = await tempGitRepo()
    repo.write("shared.txt", "base\n")
    await repo.commitAll("add shared")
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    const refsBefore = await runGit(repo.path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/loopy"])

    // when the equal state is applied
    await repository.applyChanges(worktree)

    // then nothing changes and no application metadata is persisted
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("")
    expect(await runGit(repo.path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/loopy"])).toBe(
        refsBefore
    )

    // when an initial preview is committed and the same source evolves with an overlapping edit
    fs.writeFileSync(path.join(worktree.path, "shared.txt"), "base\nsource one\n")
    await repository.applyChanges(worktree)
    await repo.commitAll("commit first preview")
    fs.writeFileSync(path.join(worktree.path, "shared.txt"), "base\nsource one\nsource two\n")
    const committedHead = await runGit(repo.path, ["rev-parse", "HEAD"])
    const repeated = repository.applyChanges(worktree)

    // then stateless three-way semantics reject the overlap without changing the committed preview
    await expect(repeated).rejects.toMatchObject({ code: "git_apply_changes_failed" })
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(committedHead)
    expect(repo.read("shared.txt")).toBe("base\nsource one\n")
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("")

    // and discarding the earlier preview allows the latest source state to be applied cleanly
    await runGit(repo.path, ["reset", "--hard", "HEAD^"])
    await repository.applyChanges(worktree)
    expect(repo.read("shared.txt")).toBe("base\nsource one\nsource two\n")
})

test("applyChanges rejects a conflict before modifying the target", async () => {
    // given source and target commits that conflict on the same file
    const repo = await tempGitRepo()
    repo.write("shared.txt", "base\n")
    await repo.commitAll("add shared file")
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "shared.txt"), "source\n")
    await worktree.stage(["shared.txt"])
    await worktree.commit("source change")
    repo.write("shared.txt", "target\n")
    await repo.commitAll("target change")
    const targetHead = await runGit(repo.path, ["rev-parse", "HEAD"])
    const targetIndex = await runGit(repo.path, ["write-tree"])
    const targetStatus = await runGit(repo.path, ["status", "--porcelain"])

    // when applying the conflicting source state
    const result = repository.applyChanges(worktree)

    // then it fails with the stable code and leaves no target conflict state or mutations
    await expect(result).rejects.toMatchObject({ code: "git_apply_changes_failed" })
    expect(repo.read("shared.txt")).toBe("target\n")
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(targetHead)
    expect(await runGit(repo.path, ["write-tree"])).toBe(targetIndex)
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe(targetStatus)
})

test.each([
    {
        name: "staged",
        mutate: async (target: string) => {
            fs.writeFileSync(path.join(target, "staged.txt"), "target change\n")
            await runGit(target, ["add", "staged.txt"])
        }
    },
    {
        name: "unstaged",
        mutate: async (target: string) => {
            fs.writeFileSync(path.join(target, "README.md"), "target change\n")
        }
    },
    {
        name: "untracked",
        mutate: async (target: string) => {
            fs.writeFileSync(path.join(target, "untracked.txt"), "target change\n")
        }
    }
])("applyChanges rejects a target with $name changes", async ({ mutate }) => {
    // given a changed source and a target with caller-owned changes
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "source.txt"), "source change\n")
    await mutate(repo.path)
    const targetStatus = await runGit(repo.path, ["status", "--porcelain"])

    // when applying the source state to the dirty target
    const result = repository.applyChanges(worktree)

    // then it fails without changing the caller-owned target state
    await expect(result).rejects.toMatchObject({ code: "git_apply_changes_failed" })
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe(targetStatus)
    expect(repo.exists("source.txt")).toBe(false)
})

test("applyChanges rejects an ignored-file collision before applying any patch", async () => {
    // given a source that starts tracking a previously ignored path already present in the target
    const repo = await tempGitRepo()
    repo.write(".gitignore", "collision.txt\n")
    await repo.commitAll("ignore collision")
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, ".gitignore"), "")
    fs.writeFileSync(path.join(worktree.path, "collision.txt"), "source content\n")
    fs.writeFileSync(path.join(repo.path, "collision.txt"), "target ignored content\n")
    const targetHead = await runGit(repo.path, ["rev-parse", "HEAD"])

    // when applying the source state
    const result = repository.applyChanges(worktree)

    // then preflight fails and preserves both the ignored file and tracked target state
    await expect(result).rejects.toMatchObject({ code: "git_apply_changes_failed" })
    expect(repo.read("collision.txt")).toBe("target ignored content\n")
    expect(repo.read(".gitignore")).toBe("collision.txt\n")
    expect(await runGit(repo.path, ["rev-parse", "HEAD"])).toBe(targetHead)
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("")
})

test("applyChanges rejects invalid checkout relationships and source histories", async () => {
    // given a repository, another repository, and source worktrees with unborn and unrelated histories
    const repo = await tempGitRepo()
    const other = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const unborn = await createWorktree(repository, { base: "main" })
    await runGit(unborn.path, ["switch", "--orphan", "unborn"])
    const unrelated = await createWorktree(repository, { base: "main" })
    await runGit(unrelated.path, ["switch", "--orphan", "unrelated"])
    fs.writeFileSync(path.join(unrelated.path, "unrelated.txt"), "unrelated\n")
    await runGit(unrelated.path, ["add", "."])
    await runGit(unrelated.path, ["commit", "-m", "unrelated root"])

    // when each invalid source is applied
    // then every invalid relationship fails without changing the target
    await expect(repository.applyChanges(new Worktree(repo.path))).rejects.toMatchObject({
        code: "git_apply_changes_failed"
    })
    await expect(repository.applyChanges(new Worktree(other.path))).rejects.toMatchObject({
        code: "git_apply_changes_failed"
    })
    await expect(repository.applyChanges(unborn)).rejects.toMatchObject({ code: "git_apply_changes_failed" })
    await expect(repository.applyChanges(unrelated)).rejects.toMatchObject({ code: "git_apply_changes_failed" })
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("")
})

test("applyChanges rejects source conflicts and target operations in progress", async () => {
    // given one source with a conflicted merge and one clean target paused before an empty merge commit
    const conflictedRepo = await tempGitRepo()
    conflictedRepo.write("shared.txt", "base\n")
    await conflictedRepo.commitAll("add shared")
    await runGit(conflictedRepo.path, ["switch", "-c", "other"])
    conflictedRepo.write("shared.txt", "other\n")
    await conflictedRepo.commitAll("other change")
    await runGit(conflictedRepo.path, ["switch", "main"])
    conflictedRepo.write("shared.txt", "main\n")
    await conflictedRepo.commitAll("main change")
    const conflictedRepository = new GitRepository(conflictedRepo.path)
    const conflictedSource = await createWorktree(conflictedRepository, { base: "main" })
    await expect(runGit(conflictedSource.path, ["merge", "other"])).rejects.toThrow()
    const operationRepo = await tempGitRepo()
    await runGit(operationRepo.path, ["switch", "-c", "other"])
    await runGit(operationRepo.path, ["commit", "--allow-empty", "-m", "other empty commit"])
    await runGit(operationRepo.path, ["switch", "main"])
    const operationRepository = new GitRepository(operationRepo.path)
    const operationSource = await createWorktree(operationRepository, { base: "main" })
    fs.writeFileSync(path.join(operationSource.path, "source.txt"), "source\n")
    await runGit(operationRepo.path, ["merge", "--no-ff", "--no-commit", "other"])

    // when applying from the conflicted source and into the paused target
    // then both operations fail without creating additional target changes
    await expect(conflictedRepository.applyChanges(conflictedSource)).rejects.toMatchObject({
        code: "git_apply_changes_failed"
    })
    await expect(operationRepository.applyChanges(operationSource)).rejects.toMatchObject({
        code: "git_apply_changes_failed"
    })
    expect(await runGit(conflictedRepo.path, ["status", "--porcelain"])).toBe("")
    expect(await runGit(operationRepo.path, ["status", "--porcelain"])).toBe("")
})

test("applyChanges is unaffected by diff presentation configuration", async () => {
    // given repository config that rewrites diff output via textconv, strips prefixes, colors and drops context
    const repo = await tempGitRepo()
    repo.write(".gitattributes", "*.dat diff=hex\n")
    repo.write("data.dat", "hello\n")
    repo.write("context.txt", "line one\nline two\nline three\nline four\nline five\n")
    await repo.commitAll("add data")
    await runGit(repo.path, ["config", "diff.hex.textconv", "od -c"])
    await runGit(repo.path, ["config", "diff.noprefix", "true"])
    await runGit(repo.path, ["config", "color.diff", "always"])
    await runGit(repo.path, ["config", "diff.context", "0"])
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "data.dat"), "world\n")
    const editedContext = "line one\nline two\nedited line\nline four\nline five\n"
    fs.writeFileSync(path.join(worktree.path, "context.txt"), editedContext)
    fs.writeFileSync(path.join(worktree.path, "plain.txt"), "plain source edit\n")

    // when the source edits are applied
    await repository.applyChanges(worktree)

    // then actual blob contents arrive as uncommitted target changes
    expect(repo.read("data.dat")).toBe("world\n")
    expect(repo.read("context.txt")).toBe(editedContext)
    expect(repo.read("plain.txt")).toBe("plain source edit\n")
    expect(await runGit(repo.path, ["diff", "--cached"])).toBe("")
})

test("applyChanges rejects submodule pointer updates instead of silently discarding them", async () => {
    // given a repository pinning a submodule and a source worktree advancing that pointer
    const sub = await tempGitRepo()
    const repo = await tempGitRepo()
    await runGit(repo.path, ["-c", "protocol.file.allow=always", "submodule", "add", sub.path, "sub"])
    await repo.commitAll("add submodule")
    const pinned = await runGit(repo.path, ["rev-parse", "HEAD:sub"])
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    sub.write("next.txt", "next\n")
    await sub.commitAll("advance submodule")
    const advanced = await runGit(sub.path, ["rev-parse", "HEAD"])
    await runGit(worktree.path, ["update-index", "--cacheinfo", `160000,${advanced},sub`])
    fs.writeFileSync(path.join(worktree.path, "beside.txt"), "beside the submodule\n")
    const targetStatus = await runGit(repo.path, ["status", "--porcelain"])

    // when the source state with the moved pointer is applied
    const result = repository.applyChanges(worktree)

    // then it fails and leaves the pinned pointer and target state untouched
    await expect(result).rejects.toMatchObject({ code: "git_apply_changes_failed" })
    expect(await runGit(repo.path, ["rev-parse", "HEAD:sub"])).toBe(pinned)
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe(targetStatus)
    expect(repo.exists("beside.txt")).toBe(false)
})
