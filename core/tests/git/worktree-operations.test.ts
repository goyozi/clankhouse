import * as fs from "node:fs"
import * as path from "node:path"
import { expect, test } from "vitest"
import { GitRepository } from "@clankhouse/core/git"
import { runGit, tempGitRepo } from "@clankhouse/test-utils"
import { createWorktree } from "./helpers"

test("worktrees live outside the repository", async () => {
    // given a repo and repository
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)

    // when a worktree is created
    const worktree = await createWorktree(repository, { base: "main" })

    // then it is placed outside the repository
    expect(worktree.path.startsWith(repo.path + path.sep)).toBe(false)
    // and the origin repo's status stays clean
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("")
})

test("stage and commit record changes", async () => {
    // given a worktree with a new untracked file
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "content")

    // when the file is staged and committed
    await worktree.stage(["new.txt"])
    await worktree.commit("add new.txt")

    // then the commit message is recorded as the latest commit
    expect(await runGit(worktree.path, ["log", "-1", "--format=%s"])).toBe("add new.txt")
    // and the worktree has no remaining changes
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe("")
})

test("stage accepts dot to stage all worktree changes", async () => {
    // given a worktree with a modified tracked file and a new nested file
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "README.md"), "changed")
    fs.mkdirSync(path.join(worktree.path, "nested"))
    fs.writeFileSync(path.join(worktree.path, "nested", "new.txt"), "content")

    // when staging with "."
    await worktree.stage(["."])

    // then both the modification and the addition are staged
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe(
        ["M  README.md", "A  nested/new.txt"].join("\n")
    )
})

test("push publishes HEAD to the upstream branch on origin", async () => {
    // given a repo with a bare origin and a worktree with a new commit
    const repo = await tempGitRepo()
    const bare = await repo.addBareOrigin()
    const repository = new GitRepository(repo.path)
    const worktree = await createWorktree(repository, { base: "main" })
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "content")
    await worktree.stage(["new.txt"])
    await worktree.commit("add new.txt")

    // when pushing to the "feature-x" branch
    await worktree.push("feature-x")

    // then the bare origin's branch points at the worktree's HEAD
    const pushed = await runGit(bare, ["rev-parse", "refs/heads/feature-x"])
    expect(pushed).toBe(await runGit(worktree.path, ["rev-parse", "HEAD"]))
})
