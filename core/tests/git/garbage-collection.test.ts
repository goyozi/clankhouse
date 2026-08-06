import * as fs from "node:fs"
import * as path from "node:path"
import { expect, test } from "vitest"
import { GitRepository, Worktree, type WorktreeReference } from "@loopy/core/git"
import { Loopy } from "@loopy/core/loopy"
import { runGit, tempDir, tempGitRepo, tempLoopy, testRun } from "@loopy/test-utils"

const OLD_CANDIDATE_DATE = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)

function ageCandidate(candidateRoot: string): void {
    fs.utimesSync(candidateRoot, OLD_CANDIDATE_DATE, OLD_CANDIDATE_DATE)
}

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
