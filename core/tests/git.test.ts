import * as fs from "node:fs"
import * as path from "node:path"
import { beforeEach, expect, test } from "vitest"
import { GitRepository } from "@loopy/core/git"
import { uniqueName } from "@loopy/core/util"
import { runGit, tempGitRepo, tempLoopy, tempLoopyDirEnv, testRun } from "@loopy/test-utils"

let loopyDir: string
beforeEach(() => {
    loopyDir = tempLoopyDirEnv()
})

test("worktree is created detached at base and reused on the next call", async () => {
    // given a fresh repo and repository
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)

    // when a worktree is created at base "main"
    const worktree = await repository.worktree({ base: "main" })

    // then it is placed under the loopy dir's worktrees directory, in a repo-scoped subdirectory
    expect(worktree.path).toBe(path.join(loopyDir, "worktrees", uniqueName(repo.path), uniqueName("main")))
    // and it contains the base branch's files
    expect(fs.existsSync(path.join(worktree.path, "README.md"))).toBe(true)

    // when the worktree is requested again for the same base
    const again = await repository.worktree({ base: "main" })

    // then the same worktree path is reused
    expect(again.path).toBe(worktree.path)
    // and the origin repo's status stays clean
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("")
})

test("worktree path is keyed by run key inside a workflow run", async () => {
    // given a loopy instance, a repo and repository
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktreePath = ""

    // when a worktree is created inside a run with key "my-run"
    await testRun(
        loopy,
        async () => {
            const worktree = await repository.worktree({ base: "main" })
            worktreePath = worktree.path
            return null
        },
        { key: "my-run" }
    )

    // then the worktree lives under the run's loopy dir, keyed by the run's unique name
    expect(worktreePath).toBe(path.join(dir, "worktrees", uniqueName(repo.path), uniqueName("test-workflow/my-run")))
})

test("named worktrees are scoped separately from the default worktree", async () => {
    // given a loopy instance, a repo and repository
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const paths: string[] = []

    // when a run creates the default worktree and two named worktrees, one of them twice
    await testRun(loopy, async () => {
        paths.push((await repository.worktree({ base: "main" })).path)
        paths.push((await repository.worktree({ base: "main", name: "candidate-1" })).path)
        paths.push((await repository.worktree({ base: "main", name: "candidate-2" })).path)
        paths.push((await repository.worktree({ base: "main", name: "candidate-1" })).path)
        return null
    })

    // then the default and named worktrees all have distinct paths
    expect(new Set(paths.slice(0, 3)).size).toBe(3)
    // and requesting the same name again reuses the same worktree
    expect(paths[3]).toBe(paths[1])
})

test("run keys that sanitize identically get distinct worktrees", async () => {
    // given a loopy instance, a repo and repository
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const paths: string[] = []

    // when a run with key "fix/123" creates a worktree
    await testRun(
        loopy,
        async () => {
            paths.push((await repository.worktree({ base: "main" })).path)
            return null
        },
        { key: "fix/123" }
    )
    // and when a run with key "fix 123" creates a worktree
    await testRun(
        loopy,
        async () => {
            paths.push((await repository.worktree({ base: "main" })).path)
            return null
        },
        { key: "fix 123" }
    )

    // then the two keys resolve to distinct worktree paths
    expect(paths[0]).not.toBe(paths[1])
})

test("a reused worktree is reset to base by default", async () => {
    // given a worktree with an untracked file and a modified tracked file
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await repository.worktree({ base: "main" })
    fs.writeFileSync(path.join(worktree.path, "junk.txt"), "junk")
    fs.writeFileSync(path.join(worktree.path, "README.md"), "changed")

    // when the worktree is requested again without preserve
    const cleaned = await repository.worktree({ base: "main" })

    // then the same worktree path is reused
    expect(cleaned.path).toBe(worktree.path)
    // and the untracked file is removed
    expect(fs.existsSync(path.join(worktree.path, "junk.txt"))).toBe(false)
    // and the tracked file is reset to its committed content
    expect(fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")).toBe("# test\n")
})

test("preserve keeps uncommitted changes across reuse", async () => {
    // given a worktree with an untracked file and a modified tracked file
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await repository.worktree({ base: "main" })
    fs.writeFileSync(path.join(worktree.path, "junk.txt"), "junk")
    fs.writeFileSync(path.join(worktree.path, "README.md"), "changed")

    // when the worktree is requested again with preserve set
    const reused = await repository.worktree({ base: "main", preserve: true })

    // then the same worktree path is reused
    expect(reused.path).toBe(worktree.path)
    // and the untracked file is kept
    expect(fs.readFileSync(path.join(worktree.path, "junk.txt"), "utf8")).toBe("junk")
    // and the tracked file keeps its uncommitted change
    expect(fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")).toBe("changed")
})

test("stage and commit record changes", async () => {
    // given a worktree with a new untracked file
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await repository.worktree({ base: "main" })
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
    const worktree = await repository.worktree({ base: "main" })
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
    const worktree = await repository.worktree({ base: "main" })
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "content")
    await worktree.stage(["new.txt"])
    await worktree.commit("add new.txt")

    // when pushing to the "feature-x" branch
    await worktree.push("feature-x")

    // then the bare origin's branch points at the worktree's HEAD
    const pushed = await runGit(bare, ["rev-parse", "refs/heads/feature-x"])
    expect(pushed).toBe(await runGit(worktree.path, ["rev-parse", "HEAD"]))
})

test("snapshot and restore round-trip covering edits, adds and deletes", async () => {
    // given a repo with a committed file that will later be deleted
    const repo = await tempGitRepo()
    repo.write("delete-me.txt", "bye")
    await repo.commitAll("add delete-me")
    const repository = new GitRepository(repo.path)
    const worktree = await repository.worktree({ base: "main" })
    const originalHead = await runGit(worktree.path, ["rev-parse", "HEAD"])

    // when a tracked file is edited, a new file is added and a tracked file is deleted, then snapshotted
    fs.writeFileSync(path.join(worktree.path, "README.md"), "changed")
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "new")
    fs.rmSync(path.join(worktree.path, "delete-me.txt"))
    await worktree.snapshot("snap1")

    // then the snapshot ref exists
    expect((await worktree.git(["rev-parse", "refs/loopy/user/snap1"])).exitCode).toBe(0)

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
})

test("snapshot leaves the user's index untouched", async () => {
    // given a worktree with one staged file and one unstaged file
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await repository.worktree({ base: "main" })
    fs.writeFileSync(path.join(worktree.path, "staged.txt"), "staged")
    fs.writeFileSync(path.join(worktree.path, "unstaged.txt"), "unstaged")
    await worktree.stage(["staged.txt"])
    const statusBefore = await runGit(worktree.path, ["status", "--porcelain"])

    // when a snapshot is taken
    await worktree.snapshot("snap1")

    // then the index/status is unchanged from before the snapshot
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe(statusBefore)
})

test("snapshot rejects invalid ref names", async () => {
    // given a worktree
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await repository.worktree({ base: "main" })

    // when snapshotting with a name containing a space
    // then it rejects with an invalid snapshot name error
    await expect(worktree.snapshot("bad name")).rejects.toThrow(/Invalid snapshot name/)
    // and when snapshotting with a name containing ".."
    // then it also rejects with an invalid snapshot name error
    await expect(worktree.snapshot("bad..name")).rejects.toThrow(/Invalid snapshot name/)
})

test("restore returns to the same commit when the worktree was fully committed", async () => {
    // given a worktree with a new file committed, leaving a clean state
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const worktree = await repository.worktree({ base: "main" })
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

test("worktrees live outside the repository", async () => {
    // given a repo and repository
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)

    // when a worktree is created
    const worktree = await repository.worktree({ base: "main" })

    // then it is placed outside the repository
    expect(worktree.path.startsWith(repo.path + path.sep)).toBe(false)
    // and the origin repo's status stays clean
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe("")
})
