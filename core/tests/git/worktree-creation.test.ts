import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { GitRepository, Worktree, type WorktreeReference } from "@clankhouse/core/git"
import { runGit, tempGitRepo, tempClankHouse, testRun } from "@clankhouse/test-utils"

test("worktree creation is a durable step publishing a random detached checkout", async () => {
    // given a ClankHouse instance and fresh repository
    const { clankhouse, dir } = tempClankHouse()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree

    // when a workflow creates a worktree at main
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })

    // then the checkout is stored under a random candidate identity
    expect(worktree.path).toMatch(
        new RegExp(`^${escapeRegExp(path.join(dir, "worktrees"))}[/\\\\][0-9A-Za-z]{21}[/\\\\]checkout$`)
    )
    // and it is detached at main with the expected files
    expect(await runGit(worktree.path, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")).toBe("detached")
    expect(fs.existsSync(path.join(worktree.path, "README.md"))).toBe(true)
    // and the run exposes only its persisted candidate identity
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    expect(run.steps).toHaveLength(1)
    expect(run.steps[0]).toMatchObject({ key: "worktree", kind: "worktree", status: "succeeded" })
    const id = path.basename(path.dirname(worktree.path))
    expect(run.steps[0].output).toEqual({ id })
    // and its manifest pins the resolved seed without storing a derivable checkout path or ref
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "worktrees", id, "candidate.json"), "utf8"))
    expect(manifest).toEqual({
        repositoryPath: fs.realpathSync(repo.path),
        seedMode: "base",
        seedOid: expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    })
    expect(manifest.seedOid).toBe(await runGit(repo.path, ["rev-parse", "main^{commit}"]))
    expect(await runGit(repo.path, ["rev-parse", `refs/clankhouse/worktrees/${id}/seed^{commit}`])).toBe(
        manifest.seedOid
    )
})

test("worktree keys obey durable prefix identity", async () => {
    // given a workflow repository
    const { clankhouse } = tempClankHouse()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const paths: string[] = []

    // when identical keys and default keys are created under different prefixes
    await testRun(clankhouse, async () => {
        paths.push((await clankhouse.prefix("one", () => repository.worktree({ base: "main", key: "review" }))).path)
        paths.push((await clankhouse.prefix("two", () => repository.worktree({ base: "main", key: "review" }))).path)
        paths.push((await clankhouse.prefix("one", () => repository.worktree({ base: "main", key: "other" }))).path)
        paths.push((await clankhouse.prefix("three", () => repository.worktree({ base: "main" }))).path)
        paths.push((await clankhouse.prefix("four", () => repository.worktree({ base: "main" }))).path)
        return null
    })

    // then every fully qualified durable key owns a distinct checkout
    expect(new Set(paths).size).toBe(paths.length)
    // and the recorded keys include their normal durable prefixes
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    expect(run.steps.map((step) => step.key)).toEqual([
        "one/worktree:review",
        "two/worktree:review",
        "one/worktree:other",
        "three/worktree",
        "four/worktree"
    ])
    // and every prefix-qualified step persisted a distinct candidate identity
    const references = run.steps.flatMap((step) => (step.kind === "worktree" ? [step.output!] : []))
    expect(new Set(references.map((reference) => reference.id)).size).toBe(references.length)
})

test("the same worktree key under one prefix is a duplicate step", async () => {
    // given a workflow repository
    const { clankhouse } = tempClankHouse()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)

    // when one prefix requests the same key twice
    const result = testRun(clankhouse, () =>
        clankhouse.prefix("review", async () => {
            await repository.worktree({ base: "main", key: "candidate" })
            await repository.worktree({ base: "main", key: "candidate" })
            return null
        })
    )

    // then normal duplicate-step validation rejects the second request
    await expect(result).rejects.toMatchObject({ code: "workflow_step_duplicate" })
})

test("worktree creation requires a workflow", async () => {
    // given a repository
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)

    // when creation is requested outside a workflow
    // then it fails before any Git side effect
    await expect(repository.worktree({ base: "main" })).rejects.toMatchObject({ code: "workflow_context_required" })
})

test("replay restores the recorded checkout without resolving a moved branch or deleting ignored files", async () => {
    // given a completed creation step whose checkout is subsequently changed
    const { clankhouse } = tempClankHouse()
    const repo = await tempGitRepo()
    repo.write(".gitignore", "dist/\n")
    await repo.commitAll("ignore build output")
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    const firstPath = await testRun(
        clankhouse,
        async () => {
            worktree = await repository.worktree({ base: "main" })
            return worktree.path
        },
        { output: z.string() }
    )
    const originalHead = await runGit(worktree.path, ["rev-parse", "HEAD"])
    fs.writeFileSync(path.join(worktree.path, "README.md"), "changed")
    fs.writeFileSync(path.join(worktree.path, "junk.txt"), "junk")
    fs.mkdirSync(path.join(worktree.path, "dist"))
    fs.writeFileSync(path.join(worktree.path, "dist", "stale.txt"), "stale")
    repo.write("new-main.txt", "new")
    await repo.commitAll("move main")
    const runId = (await clankhouse.runs.list())[0].id
    clankhouse.db
        .prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(runId)

    // when the run replays worktree creation after main moved
    const replayedPath = await testRun(clankhouse, async () => (await repository.worktree({ base: "main" })).path, {
        output: z.string()
    })

    // then it returns and restores the exact recorded checkout
    expect(replayedPath).toBe(firstPath)
    expect(await runGit(replayedPath, ["rev-parse", "HEAD"])).toBe(originalHead)
    expect(await runGit(replayedPath, ["status", "--porcelain"])).toBe("")
    expect(fs.existsSync(path.join(replayedPath, "junk.txt"))).toBe(false)
    expect(fs.existsSync(path.join(replayedPath, "dist", "stale.txt"))).toBe(true)
    // and it did not follow the moved branch
    expect(originalHead).not.toBe(await runGit(repo.path, ["rev-parse", "main"]))
})

test("includeUncommitted copies the working tree and exact index state", async () => {
    // given a repository with staged, unstaged, deleted, untracked and ignored changes
    const repo = await tempGitRepo()
    repo.write(".gitignore", "ignored.txt\nforce-added.txt\n")
    repo.write("delete-unstaged.txt", "delete")
    repo.write("delete-staged.txt", "delete")
    await repo.commitAll("add fixtures")
    repo.write("README.md", "staged\n")
    await runGit(repo.path, ["add", "README.md"])
    repo.write("README.md", "staged\nunstaged\n")
    repo.write("new-staged.txt", "staged\n")
    await runGit(repo.path, ["add", "new-staged.txt"])
    repo.write("new-staged.txt", "staged\nunstaged\n")
    repo.write("new-untracked.txt", "untracked")
    repo.write("ignored.txt", "ignored")
    repo.write("force-added.txt", "force-added")
    await runGit(repo.path, ["add", "--force", "force-added.txt"])
    fs.rmSync(path.join(repo.path, "delete-unstaged.txt"))
    fs.rmSync(path.join(repo.path, "delete-staged.txt"))
    await runGit(repo.path, ["add", "delete-staged.txt"])
    const statusBefore = await runGit(repo.path, ["status", "--porcelain"])
    const cachedBefore = await runGit(repo.path, ["diff", "--cached", "--binary"])
    const unstagedBefore = await runGit(repo.path, ["diff", "--binary"])
    const indexBefore = fs.readFileSync(path.join(repo.path, ".git", "index"))
    const repository = new GitRepository(repo.path)
    const { clankhouse } = tempClankHouse()
    let worktree!: Worktree

    // when a workflow includes the current uncommitted state
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree({ includeUncommitted: true })
        return null
    })

    // then the checkout reproduces the source status, index and working tree
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe(statusBefore)
    expect(await runGit(worktree.path, ["diff", "--cached", "--binary"])).toBe(cachedBefore)
    expect(await runGit(worktree.path, ["diff", "--binary"])).toBe(unstagedBefore)
    expect(fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")).toBe("staged\nunstaged\n")
    expect(fs.existsSync(path.join(worktree.path, "ignored.txt"))).toBe(false)
    expect(fs.readFileSync(path.join(worktree.path, "force-added.txt"), "utf8")).toBe("force-added")
    // and the source repository remains byte-for-byte and index-for-index unchanged
    expect(await runGit(repo.path, ["status", "--porcelain"])).toBe(statusBefore)
    expect(await runGit(repo.path, ["diff", "--cached", "--binary"])).toBe(cachedBefore)
    expect(await runGit(repo.path, ["diff", "--binary"])).toBe(unstagedBefore)
    expect(fs.readFileSync(path.join(repo.path, ".git", "index"))).toEqual(indexBefore)
    // and replay restores that captured seed rather than newer checkout or source changes
    fs.writeFileSync(path.join(worktree.path, "README.md"), "agent change")
    fs.writeFileSync(path.join(worktree.path, "agent.txt"), "agent")
    repo.write("later-source.txt", "later")
    const runId = (await clankhouse.runs.list())[0].id
    clankhouse.db
        .prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(runId)
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree({ includeUncommitted: true })
        return null
    })
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe(statusBefore)
    expect(await runGit(worktree.path, ["diff", "--cached", "--binary"])).toBe(cachedBefore)
    expect(await runGit(worktree.path, ["diff", "--binary"])).toBe(unstagedBefore)
    expect(fs.existsSync(path.join(worktree.path, "agent.txt"))).toBe(false)
    expect(fs.existsSync(path.join(worktree.path, "later-source.txt"))).toBe(false)
})

test("replay reconstructs a missing includeUncommitted checkout from its captured seed", async () => {
    // given a worktree seeded from distinct staged, unstaged and untracked source changes
    const { clankhouse, dir } = tempClankHouse()
    const repo = await tempGitRepo()
    repo.write("README.md", "staged\n")
    await runGit(repo.path, ["add", "README.md"])
    repo.write("README.md", "staged\nunstaged\n")
    repo.write("untracked.txt", "untracked")
    const statusBefore = await runGit(repo.path, ["status", "--porcelain"])
    const cachedBefore = await runGit(repo.path, ["diff", "--cached", "--binary"])
    const unstagedBefore = await runGit(repo.path, ["diff", "--binary"])
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree({ includeUncommitted: true })
        return null
    })
    const id = path.basename(path.dirname(worktree.path))
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "worktrees", id, "candidate.json"), "utf8"))
    await runGit(repo.path, ["worktree", "remove", "--force", worktree.path])
    repo.write("later.txt", "later")
    const runId = (await clankhouse.runs.list())[0].id
    clankhouse.db
        .prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(runId)

    // when the durable creation step replays without its checkout or registration
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree({ includeUncommitted: true })
        return null
    })

    // then it recreates the original source state from the pinned snapshot envelope
    expect(manifest.seedMode).toBe("uncommitted")
    expect(await runGit(repo.path, ["rev-parse", `refs/clankhouse/worktrees/${id}/seed^{commit}`])).toBe(
        manifest.seedOid
    )
    expect(await runGit(worktree.path, ["status", "--porcelain"])).toBe(statusBefore)
    expect(await runGit(worktree.path, ["diff", "--cached", "--binary"])).toBe(cachedBefore)
    expect(await runGit(worktree.path, ["diff", "--binary"])).toBe(unstagedBefore)
    expect(fs.existsSync(path.join(worktree.path, "later.txt"))).toBe(false)
})

test("includeUncommitted preserves an unmerged index and conflict working tree", async () => {
    // given a repository whose current merge has unresolved index entries
    const repo = await tempGitRepo()
    await runGit(repo.path, ["switch", "-c", "other"])
    repo.write("README.md", "other\n")
    await repo.commitAll("other change")
    await runGit(repo.path, ["switch", "main"])
    repo.write("README.md", "main\n")
    await repo.commitAll("main change")
    await expect(runGit(repo.path, ["merge", "other"])).rejects.toThrow()
    const stagesBefore = await runGit(repo.path, ["ls-files", "--stage"])
    const conflictBefore = fs.readFileSync(path.join(repo.path, "README.md"), "utf8")
    const repository = new GitRepository(repo.path)
    const { clankhouse } = tempClankHouse()
    let worktree!: Worktree

    // when a workflow captures the uncommitted repository
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree({ includeUncommitted: true })
        return null
    })

    // then the checkout contains the same conflict stages and working file
    expect(await runGit(worktree.path, ["ls-files", "--stage"])).toBe(stagesBefore)
    expect(fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")).toBe(conflictBefore)
})

test("replay reconstructs a missing recorded checkout from its immutable seed", async () => {
    // given a succeeded worktree creation whose checkout disappears while its registration remains
    const { clankhouse } = tempClankHouse()
    const repo = await tempGitRepo()
    repo.write(".gitignore", "cache/\n")
    await repo.commitAll("ignore cache")
    const repository = new GitRepository(repo.path)
    const worktreePath = await testRun(clankhouse, async () => (await repository.worktree({ base: "main" })).path, {
        output: z.string()
    })
    const seededHead = await runGit(worktreePath, ["rev-parse", "HEAD"])
    fs.mkdirSync(path.join(worktreePath, "cache"))
    fs.writeFileSync(path.join(worktreePath, "cache", "ephemeral.txt"), "cache")
    fs.rmSync(worktreePath, { recursive: true })
    repo.write("later.txt", "later")
    await repo.commitAll("move main")
    const runId = (await clankhouse.runs.list())[0].id
    clankhouse.db
        .prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(runId)

    // when the creation step replays
    const replayedPath = await testRun(clankhouse, async () => (await repository.worktree({ base: "main" })).path, {
        output: z.string()
    })

    // then it recreates the same detached checkout from the original seed
    expect(replayedPath).toBe(worktreePath)
    expect(await runGit(replayedPath, ["rev-parse", "HEAD"])).toBe(seededHead)
    expect(fs.existsSync(path.join(replayedPath, "later.txt"))).toBe(false)
    // and ignored content is absent because it was not durable state
    expect(fs.existsSync(path.join(replayedPath, "cache", "ephemeral.txt"))).toBe(false)
})

test("replay rejects a moved seed ref before modifying the checkout", async () => {
    // given a recorded worktree whose private seed ref is moved and whose checkout has new work
    const { clankhouse } = tempClankHouse()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    fs.writeFileSync(path.join(worktree.path, "keep.txt"), "keep")
    repo.write("later.txt", "later")
    await repo.commitAll("later")
    await runGit(repo.path, ["update-ref", `refs/clankhouse/worktrees/${reference.id}/seed`, "main"])
    clankhouse.db
        .prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(run.id)

    // when the creation step replays
    const replay = testRun(clankhouse, () => repository.worktree({ base: "main" }))

    // then it fails without resetting the existing checkout
    await expect(replay).rejects.toMatchObject({ code: "git_worktree_unavailable" })
    expect(fs.readFileSync(path.join(worktree.path, "keep.txt"), "utf8")).toBe("keep")
})

test("replay rejects missing candidate metadata without modifying the checkout", async () => {
    // given a recorded worktree whose manifest is missing and whose checkout has new work
    const { clankhouse, dir } = tempClankHouse()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    fs.rmSync(path.join(dir, "worktrees", reference.id, "candidate.json"))
    fs.writeFileSync(path.join(worktree.path, "keep.txt"), "keep")
    clankhouse.db
        .prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(run.id)

    // when the creation step replays
    const replay = testRun(clankhouse, () => repository.worktree({ base: "main" }))

    // then it fails without resetting the existing checkout
    await expect(replay).rejects.toMatchObject({ code: "git_worktree_unavailable" })
    expect(fs.readFileSync(path.join(worktree.path, "keep.txt"), "utf8")).toBe("keep")
})

test("replay rejects candidate metadata belonging to another repository", async () => {
    // given a recorded worktree whose manifest repository identity is changed
    const { clankhouse, dir } = tempClankHouse()
    const repo = await tempGitRepo()
    const other = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    const manifestPath = path.join(dir, "worktrees", reference.id, "candidate.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, repositoryPath: fs.realpathSync(other.path) }))
    fs.writeFileSync(path.join(worktree.path, "keep.txt"), "keep")
    clankhouse.db
        .prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(run.id)

    // when the creation step replays
    const replay = testRun(clankhouse, () => repository.worktree({ base: "main" }))

    // then it fails without resetting the existing checkout
    await expect(replay).rejects.toMatchObject({ code: "git_worktree_unavailable" })
    expect(fs.readFileSync(path.join(worktree.path, "keep.txt"), "utf8")).toBe("keep")
})

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
