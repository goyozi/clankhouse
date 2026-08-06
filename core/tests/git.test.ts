import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import * as z from "zod"
import { expect, test } from "vitest"
import { GitRepository, Worktree, type WorktreeOptions, type WorktreeReference } from "@loopy/core/git"
import { Loopy } from "@loopy/core/loopy"
import { runGit, tempDir, tempGitRepo, tempLoopy, testRun } from "@loopy/test-utils"

const OLD_CANDIDATE_DATE = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)

function ageCandidate(candidateRoot: string): void {
    fs.utimesSync(candidateRoot, OLD_CANDIDATE_DATE, OLD_CANDIDATE_DATE)
}

function userSnapshotRef(worktree: Worktree, name: string): string {
    const namespace = createHash("sha256").update(path.resolve(worktree.path)).digest("hex")
    return `refs/loopy/user/${namespace}/${name}`
}

async function writeTree(worktree: Worktree, entries: { mode: string; oid: string; path: string }[]): Promise<string> {
    const indexPath = await runGit(worktree.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
    const index = fs.readFileSync(indexPath)
    try {
        await runGit(worktree.path, ["read-tree", "--empty"])
        for (const entry of entries) {
            await runGit(worktree.path, ["update-index", "--add", "--cacheinfo", entry.mode, entry.oid, entry.path])
        }
        return await runGit(worktree.path, ["write-tree"])
    } finally {
        fs.writeFileSync(indexPath, index)
    }
}

async function createWorktree(repository: GitRepository, options: WorktreeOptions): Promise<Worktree> {
    const { loopy } = tempLoopy()
    let worktree!: Worktree
    await testRun(loopy, async () => {
        worktree = await repository.worktree(options)
        return null
    })
    return worktree
}

test("worktree creation is a durable step publishing a random detached checkout", async () => {
    // given a Loopy instance and fresh repository
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree

    // when a workflow creates a worktree at main
    await testRun(loopy, async () => {
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
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
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
    expect(await runGit(repo.path, ["rev-parse", `refs/loopy/worktrees/${id}/seed^{commit}`])).toBe(manifest.seedOid)
})

test("worktree keys obey durable prefix identity", async () => {
    // given a workflow repository
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const paths: string[] = []

    // when identical keys and default keys are created under different prefixes
    await testRun(loopy, async () => {
        paths.push((await loopy.prefix("one", () => repository.worktree({ base: "main", key: "review" }))).path)
        paths.push((await loopy.prefix("two", () => repository.worktree({ base: "main", key: "review" }))).path)
        paths.push((await loopy.prefix("one", () => repository.worktree({ base: "main", key: "other" }))).path)
        paths.push((await loopy.prefix("three", () => repository.worktree({ base: "main" }))).path)
        paths.push((await loopy.prefix("four", () => repository.worktree({ base: "main" }))).path)
        return null
    })

    // then every fully qualified durable key owns a distinct checkout
    expect(new Set(paths).size).toBe(paths.length)
    // and the recorded keys include their normal durable prefixes
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
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
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)

    // when one prefix requests the same key twice
    const result = testRun(loopy, () =>
        loopy.prefix("review", async () => {
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
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    repo.write(".gitignore", "dist/\n")
    await repo.commitAll("ignore build output")
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    const firstPath = await testRun(
        loopy,
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
    const runId = (await loopy.runs.list())[0].id
    loopy.db.prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?").run(runId)

    // when the run replays worktree creation after main moved
    const replayedPath = await testRun(loopy, async () => (await repository.worktree({ base: "main" })).path, {
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
    const { loopy } = tempLoopy()
    let worktree!: Worktree

    // when a workflow includes the current uncommitted state
    await testRun(loopy, async () => {
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
    const runId = (await loopy.runs.list())[0].id
    loopy.db.prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?").run(runId)
    await testRun(loopy, async () => {
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
    const { loopy, dir } = tempLoopy()
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
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ includeUncommitted: true })
        return null
    })
    const id = path.basename(path.dirname(worktree.path))
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "worktrees", id, "candidate.json"), "utf8"))
    await runGit(repo.path, ["worktree", "remove", "--force", worktree.path])
    repo.write("later.txt", "later")
    const runId = (await loopy.runs.list())[0].id
    loopy.db.prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?").run(runId)

    // when the durable creation step replays without its checkout or registration
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ includeUncommitted: true })
        return null
    })

    // then it recreates the original source state from the pinned snapshot envelope
    expect(manifest.seedMode).toBe("uncommitted")
    expect(await runGit(repo.path, ["rev-parse", `refs/loopy/worktrees/${id}/seed^{commit}`])).toBe(manifest.seedOid)
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
    const { loopy } = tempLoopy()
    let worktree!: Worktree

    // when a workflow captures the uncommitted repository
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ includeUncommitted: true })
        return null
    })

    // then the checkout contains the same conflict stages and working file
    expect(await runGit(worktree.path, ["ls-files", "--stage"])).toBe(stagesBefore)
    expect(fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")).toBe(conflictBefore)
})

test("replay reconstructs a missing recorded checkout from its immutable seed", async () => {
    // given a succeeded worktree creation whose checkout disappears while its registration remains
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    repo.write(".gitignore", "cache/\n")
    await repo.commitAll("ignore cache")
    const repository = new GitRepository(repo.path)
    const worktreePath = await testRun(loopy, async () => (await repository.worktree({ base: "main" })).path, {
        output: z.string()
    })
    const seededHead = await runGit(worktreePath, ["rev-parse", "HEAD"])
    fs.mkdirSync(path.join(worktreePath, "cache"))
    fs.writeFileSync(path.join(worktreePath, "cache", "ephemeral.txt"), "cache")
    fs.rmSync(worktreePath, { recursive: true })
    repo.write("later.txt", "later")
    await repo.commitAll("move main")
    const runId = (await loopy.runs.list())[0].id
    loopy.db.prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?").run(runId)

    // when the creation step replays
    const replayedPath = await testRun(loopy, async () => (await repository.worktree({ base: "main" })).path, {
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
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    fs.writeFileSync(path.join(worktree.path, "keep.txt"), "keep")
    repo.write("later.txt", "later")
    await repo.commitAll("later")
    await runGit(repo.path, ["update-ref", `refs/loopy/worktrees/${reference.id}/seed`, "main"])
    loopy.db.prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?").run(run.id)

    // when the creation step replays
    const replay = testRun(loopy, () => repository.worktree({ base: "main" }))

    // then it fails without resetting the existing checkout
    await expect(replay).rejects.toMatchObject({ code: "git_worktree_unavailable" })
    expect(fs.readFileSync(path.join(worktree.path, "keep.txt"), "utf8")).toBe("keep")
})

test("replay rejects missing candidate metadata without modifying the checkout", async () => {
    // given a recorded worktree whose manifest is missing and whose checkout has new work
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    fs.rmSync(path.join(dir, "worktrees", reference.id, "candidate.json"))
    fs.writeFileSync(path.join(worktree.path, "keep.txt"), "keep")
    loopy.db.prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?").run(run.id)

    // when the creation step replays
    const replay = testRun(loopy, () => repository.worktree({ base: "main" }))

    // then it fails without resetting the existing checkout
    await expect(replay).rejects.toMatchObject({ code: "git_worktree_unavailable" })
    expect(fs.readFileSync(path.join(worktree.path, "keep.txt"), "utf8")).toBe("keep")
})

test("replay rejects candidate metadata belonging to another repository", async () => {
    // given a recorded worktree whose manifest repository identity is changed
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const other = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    const manifestPath = path.join(dir, "worktrees", reference.id, "candidate.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, repositoryPath: fs.realpathSync(other.path) }))
    fs.writeFileSync(path.join(worktree.path, "keep.txt"), "keep")
    loopy.db.prepare("UPDATE runs SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?").run(run.id)

    // when the creation step replays
    const replay = testRun(loopy, () => repository.worktree({ base: "main" }))

    // then it fails without resetting the existing checkout
    await expect(replay).rejects.toMatchObject({ code: "git_worktree_unavailable" })
    expect(fs.readFileSync(path.join(worktree.path, "keep.txt"), "utf8")).toBe("keep")
})

test("gc removes unreachable candidates and retains durable worktrees", async () => {
    // given two durable worktrees with one publication record made unreachable
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const paths: string[] = []
    await testRun(loopy, async () => {
        paths.push((await repository.worktree({ base: "main", key: "orphan" })).path)
        paths.push((await repository.worktree({ base: "main", key: "reachable" })).path)
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const orphan = run.steps.find((step) => step.key === "worktree:orphan")!
    const orphanReference = orphan.output as WorktreeReference
    const orphanSeedRef = `refs/loopy/worktrees/${orphanReference.id}/seed`
    loopy.db
        .prepare("UPDATE steps SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(orphan.id)
    loopy.db.prepare("UPDATE runs SET status = 'failed', output = NULL, error = 'boom' WHERE id = ?").run(run.id)
    await runGit(repo.path, ["update-ref", "refs/loopy/user/unrelated", "HEAD"])
    await runGit(repo.path, ["update-ref", "refs/loopy/agent/unrelated", "HEAD"])
    ageCandidate(path.dirname(paths[0]))
    ageCandidate(path.dirname(paths[1]))

    // when garbage collection runs
    const result = await loopy.gc()

    // then only the unreachable checkout and its seed ref are removed
    expect(result).toEqual({ worktrees: { removed: 1, paths: [paths[0]] } })
    expect(fs.existsSync(paths[0])).toBe(false)
    expect(fs.existsSync(paths[1])).toBe(true)
    await expect(runGit(repo.path, ["rev-parse", "--verify", orphanSeedRef])).rejects.toThrow()
    expect(await runGit(repo.path, ["worktree", "list", "--porcelain"])).not.toContain(paths[0])
    // and snapshot refs remain outside the worktree-only sweep
    expect(await runGit(repo.path, ["rev-parse", "--verify", "refs/loopy/user/unrelated"])).not.toBe("")
    expect(await runGit(repo.path, ["rev-parse", "--verify", "refs/loopy/agent/unrelated"])).not.toBe("")
})

test("gc removes stale restore rescue refs and retains recent ones", async () => {
    // given a durable worktree repository with stale and recent temporary restore refs
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    await testRun(loopy, async () => {
        await repository.worktree({ base: "main" })
        return null
    })
    const staleRef = `refs/loopy/restore/0-${"A".repeat(21)}`
    const recentRef = `refs/loopy/restore/${Date.now()}-${"B".repeat(21)}`
    await runGit(repo.path, ["update-ref", staleRef, "HEAD"])
    await runGit(repo.path, ["update-ref", recentRef, "HEAD"])

    // when worktree garbage collection scans the discoverable repository
    await loopy.gc()

    // then only the rescue ref older than the collection grace period is removed
    await expect(runGit(repo.path, ["rev-parse", "--verify", staleRef])).rejects.toThrow()
    expect(await runGit(repo.path, ["rev-parse", "--verify", recentRef])).not.toBe("")
})

test("gc retains young unregistered candidates until they reach the minimum age", async () => {
    // given a newly created unregistered candidate
    const { loopy, dir } = tempLoopy()
    const candidateRoot = path.join(dir, "worktrees", "A".repeat(21))
    fs.mkdirSync(candidateRoot, { recursive: true })
    fs.writeFileSync(path.join(candidateRoot, "candidate.json.tmp"), "{")

    // when garbage collection runs before the quarantine expires
    const youngResult = await loopy.gc()

    // then it leaves the candidate untouched
    expect(youngResult).toEqual({ worktrees: { removed: 0, paths: [] } })
    expect(fs.existsSync(candidateRoot)).toBe(true)
    // and once old enough it is removed regardless of the partial manifest
    ageCandidate(candidateRoot)
    expect(await loopy.gc()).toEqual({
        worktrees: { removed: 1, paths: [path.join(candidateRoot, "checkout")] }
    })
    expect(fs.existsSync(candidateRoot)).toBe(false)
})

test("gc does not let an unregistered candidate manifest target a durable worktree", async () => {
    // given an old durable worktree and an old candidate whose manifest points to it
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let durable!: Worktree
    await testRun(loopy, async () => {
        durable = await repository.worktree({ base: "main" })
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    const durableManifest = JSON.parse(
        fs.readFileSync(path.join(dir, "worktrees", reference.id, "candidate.json"), "utf8")
    )
    const candidateRoot = path.join(dir, "worktrees", "A".repeat(21))
    fs.mkdirSync(candidateRoot, { recursive: true })
    fs.writeFileSync(path.join(candidateRoot, "candidate.json"), JSON.stringify(durableManifest))
    ageCandidate(path.dirname(durable.path))
    ageCandidate(candidateRoot)

    // when garbage collection scans the mismatched candidate
    const result = await loopy.gc()

    // then it removes only that candidate without acting on the manifest target
    expect(result).toEqual({
        worktrees: { removed: 1, paths: [path.join(candidateRoot, "checkout")] }
    })
    expect(fs.existsSync(candidateRoot)).toBe(false)
    expect(fs.existsSync(durable.path)).toBe(true)
    expect(await runGit(repo.path, ["rev-parse", "--verify", `refs/loopy/worktrees/${reference.id}/seed`])).not.toBe("")
})

test("gc removes old unregistered candidates regardless of their contents or metadata", async () => {
    // given old candidates with corrupt, missing-repository and partial metadata
    const { loopy, dir } = tempLoopy()
    const worktreesRoot = path.join(dir, "worktrees")
    const corruptRoot = path.join(worktreesRoot, "A".repeat(21))
    fs.mkdirSync(path.join(corruptRoot, "checkout"), { recursive: true })
    fs.writeFileSync(path.join(corruptRoot, "candidate.json"), "{")
    const missingRepository = path.join(dir, "missing-repository")
    const missingId = "B".repeat(21)
    const missingRoot = path.join(worktreesRoot, missingId)
    fs.mkdirSync(missingRoot, { recursive: true })
    fs.writeFileSync(
        path.join(missingRoot, "candidate.json"),
        JSON.stringify({
            repositoryPath: missingRepository,
            seedMode: "base",
            seedOid: "0".repeat(40)
        })
    )
    const removableRoot = path.join(worktreesRoot, "C".repeat(21))
    fs.mkdirSync(removableRoot, { recursive: true })
    fs.writeFileSync(path.join(removableRoot, "candidate.json.tmp"), "{")
    ageCandidate(corruptRoot)
    ageCandidate(missingRoot)
    ageCandidate(removableRoot)

    // when garbage collection scans all candidates
    const result = await loopy.gc()

    // then every unregistered candidate is removed
    expect(result).toEqual({
        worktrees: {
            removed: 3,
            paths: [corruptRoot, missingRoot, removableRoot].map((root) => path.join(root, "checkout"))
        }
    })
    expect(fs.existsSync(removableRoot)).toBe(false)
    expect(fs.existsSync(corruptRoot)).toBe(false)
    expect(fs.existsSync(missingRoot)).toBe(false)
})

test("gc removes a plain candidate nested under an enclosing repository", async () => {
    // given a valid orphan candidate whose plain checkout is nested under the source repository
    const repo = await tempGitRepo()
    const loopyDir = path.join(repo.path, ".loopy")
    const id = "D".repeat(21)
    const candidateRoot = path.join(loopyDir, "worktrees", id)
    const checkout = path.join(candidateRoot, "checkout")
    const seedOid = await runGit(repo.path, ["rev-parse", "HEAD"])
    fs.mkdirSync(checkout, { recursive: true })
    fs.writeFileSync(path.join(checkout, "leftover.txt"), "leftover")
    fs.writeFileSync(
        path.join(candidateRoot, "candidate.json"),
        JSON.stringify({
            repositoryPath: repo.path,
            seedMode: "base",
            seedOid
        })
    )
    await runGit(repo.path, ["update-ref", `refs/loopy/worktrees/${id}/seed`, seedOid, ""])
    ageCandidate(candidateRoot)
    const nested = new Loopy(loopyDir)

    // when garbage collection probes the plain checkout
    try {
        const result = await nested.gc()

        // then it ignores the enclosing repository and removes the candidate
        expect(result.worktrees).toEqual({ removed: 1, paths: [checkout] })
        expect(fs.existsSync(candidateRoot)).toBe(false)
    } finally {
        nested.close()
    }
})

test("gc does not prune unrelated missing worktrees from the repository", async () => {
    // given an unreachable Loopy worktree and an unrelated registered worktree whose path is temporarily missing
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let loopyWorktree!: Worktree
    await testRun(loopy, async () => {
        loopyWorktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    loopy.db
        .prepare("UPDATE steps SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(run.steps[0].id)
    ageCandidate(path.dirname(loopyWorktree.path))
    const externalParent = tempDir("loopy-external-worktree-")
    const movedParent = tempDir("loopy-moved-worktree-")
    const externalPath = path.join(externalParent, "checkout")
    const movedPath = path.join(movedParent, "checkout")
    await runGit(repo.path, ["worktree", "add", "--detach", externalPath, "main"])
    fs.renameSync(externalPath, movedPath)

    // when garbage collection removes only the unreachable Loopy worktree
    const result = await loopy.gc()

    // then the unrelated missing worktree remains registered
    expect(result.worktrees).toEqual({ removed: 1, paths: [loopyWorktree.path] })
    expect(await runGit(repo.path, ["worktree", "list", "--porcelain"])).toContain(externalPath)
})

test("gc protects reachable IDs without trusting their candidate manifest", async () => {
    // given an old reachable candidate with stale metadata and an old unreachable candidate
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const paths: string[] = []
    await testRun(loopy, async () => {
        paths.push((await repository.worktree({ base: "main", key: "reachable" })).path)
        paths.push((await repository.worktree({ base: "main", key: "orphan" })).path)
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const reachable = run.steps.find((step) => step.key === "worktree:reachable")!.output as WorktreeReference
    const orphan = run.steps.find((step) => step.key === "worktree:orphan")!
    loopy.db
        .prepare("UPDATE steps SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(orphan.id)
    fs.writeFileSync(
        path.join(dir, "worktrees", reachable.id, "candidate.json"),
        JSON.stringify({ repositoryPath: path.join(dir, "stale-repository"), seedMode: "base" })
    )
    ageCandidate(path.dirname(paths[0]))
    ageCandidate(path.dirname(paths[1]))

    // when garbage collection scans the candidates
    const result = await loopy.gc()

    // then the durable ID remains protected while the unrelated orphan is collected
    expect(result.worktrees).toEqual({ removed: 1, paths: [paths[1]] })
    expect(fs.existsSync(paths[0])).toBe(true)
    expect(fs.existsSync(paths[1])).toBe(false)
})

test("gc fails closed before deletion when durable candidate output is malformed", async () => {
    // given an old candidate whose succeeded durable row has no recoverable valid ID
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    loopy.db.prepare("UPDATE steps SET output = ? WHERE id = ?").run(JSON.stringify({ id: "invalid" }), run.steps[0].id)
    ageCandidate(path.dirname(worktree.path))

    // when garbage collection reads durable reachability
    const result = loopy.gc()

    // then it fails closed and leaves the candidate untouched
    await expect(result).rejects.toMatchObject({ code: "git_worktree_gc_failed" })
    expect(fs.existsSync(worktree.path)).toBe(true)
})

test("gc removes a candidate whose seed ref was already cleaned up", async () => {
    // given an old unreachable candidate left behind by an interrupted earlier sweep
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    loopy.db
        .prepare("UPDATE steps SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(run.steps[0].id)
    await runGit(repo.path, ["worktree", "remove", "--force", worktree.path])
    await runGit(repo.path, ["update-ref", "-d", `refs/loopy/worktrees/${reference.id}/seed`])
    const candidateRoot = path.dirname(worktree.path)
    ageCandidate(candidateRoot)

    // when the next sweep encounters the partially cleaned candidate
    const result = await loopy.gc()

    // then it removes the leftover candidate directory instead of failing
    expect(result.worktrees).toEqual({ removed: 1, paths: [worktree.path] })
    expect(fs.existsSync(candidateRoot)).toBe(false)
})

test("gc retains candidate metadata when seed-ref deletion fails", async () => {
    // given an old unreachable candidate whose seed ref is locked against deletion
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    loopy.db
        .prepare("UPDATE steps SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(run.steps[0].id)
    const candidateRoot = path.dirname(worktree.path)
    const seedRef = `refs/loopy/worktrees/${reference.id}/seed`
    const seedLock = path.join(repo.path, ".git", `${seedRef}.lock`)
    fs.writeFileSync(seedLock, "locked")
    ageCandidate(candidateRoot)

    // when garbage collection cannot finish the ordered Git cleanup
    const failed = loopy.gc()

    // then it reports failure and keeps the manifest and seed ref for retry
    await expect(failed).rejects.toMatchObject({ code: "git_worktree_gc_failed" })
    expect(fs.existsSync(path.join(candidateRoot, "candidate.json"))).toBe(true)
    expect(await runGit(repo.path, ["rev-parse", "--verify", seedRef])).not.toBe("")
    // and a later eligible sweep completes after the lock is removed
    fs.rmSync(seedLock)
    ageCandidate(candidateRoot)
    expect(await loopy.gc()).toEqual({ worktrees: { removed: 1, paths: [worktree.path] } })
})

test("gc rejects a moved seed ref before removing candidate state", async () => {
    // given an old unreachable candidate whose private seed ref moved to another commit
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let worktree!: Worktree
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return null
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const reference = run.steps[0].output as WorktreeReference
    loopy.db
        .prepare("UPDATE steps SET status = 'interrupted', output = NULL, ended_at = NULL WHERE id = ?")
        .run(run.steps[0].id)
    repo.write("later.txt", "later")
    await repo.commitAll("later")
    await runGit(repo.path, ["update-ref", `refs/loopy/worktrees/${reference.id}/seed`, "main"])
    ageCandidate(path.dirname(worktree.path))

    // when garbage collection validates the candidate
    const result = loopy.gc()

    // then it fails before removing the checkout, manifest, or moved ref
    await expect(result).rejects.toMatchObject({ code: "git_worktree_gc_failed" })
    expect(fs.existsSync(worktree.path)).toBe(true)
    expect(fs.existsSync(path.join(path.dirname(worktree.path), "candidate.json"))).toBe(true)
    expect(await runGit(repo.path, ["rev-parse", `refs/loopy/worktrees/${reference.id}/seed`])).toBe(
        await runGit(repo.path, ["rev-parse", "main"])
    )
})

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

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
