import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { type GitRepository, Worktree, type WorktreeOptions } from "@clankhouse/core/git"
import { runGit, tempClankHouse, testRun } from "@clankhouse/test-utils"

export function userSnapshotRef(worktree: Worktree, name: string): string {
    const namespace = createHash("sha256").update(path.resolve(worktree.path)).digest("hex")
    return `refs/clankhouse/user/${namespace}/${name}`
}

export async function writeTree(
    worktree: Worktree,
    entries: { mode: string; oid: string; path: string }[]
): Promise<string> {
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

export async function createWorktree(repository: GitRepository, options: WorktreeOptions): Promise<Worktree> {
    const { clankhouse } = tempClankHouse()
    let worktree!: Worktree
    await testRun(clankhouse, async () => {
        worktree = await repository.worktree(options)
        return null
    })
    return worktree
}
