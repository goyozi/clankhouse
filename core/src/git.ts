import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runContext } from "./context"
import { exists, resolveLoopyDir, uniqueName } from "./util"

export class GitRepository {
    readonly path: string

    constructor(path: string) {
        this.path = path
    }

    /**
     * Creates (or reuses) a worktree under `<loopyDir>/worktrees/`, detached at `base`.
     * The worktree path is derived from the repository path plus the current run key
     * when called inside a workflow run, or `base` otherwise; providing `name` yields a
     * separate worktree scoped to the same run key (e.g. for Best-of-N workflows).
     * A reused worktree is reset to `base`, discarding uncommitted changes, unless
     * `preserve` is set — so by default each call, including on resume, starts clean.
     */
    async worktree(options: WorktreeOptions): Promise<Worktree> {
        const ctx = runContext.getStore()
        const identity = ctx ? `${ctx.workflowName}/${ctx.runKey}` : options.base
        const name = uniqueName(options.name === undefined ? identity : `${identity}/${options.name}`)
        const loopyDir = ctx?.loopy.loopyDir ?? resolveLoopyDir()
        const worktreePath = path.join(loopyDir, "worktrees", uniqueName(this.path), name)
        if (await exists(worktreePath)) {
            const worktree = new Worktree(worktreePath)
            if (!options.preserve) {
                await resetTo(worktreePath, options.base)
            }
            return worktree
        }
        await mkdir(path.dirname(worktreePath), { recursive: true })
        await mustGit(this.path, ["worktree", "add", "--detach", worktreePath, options.base])
        return new Worktree(worktreePath)
    }
}

export class Worktree {
    readonly path: string

    constructor(path: string) {
        this.path = path
    }

    async stage(files: string[]): Promise<void> {
        await mustGit(this.path, ["add", "--", ...files])
    }

    async commit(message: string): Promise<void> {
        await mustGit(this.path, ["commit", "-m", message])
    }

    async push(upstreamBranchName: string): Promise<void> {
        await mustGit(this.path, ["push", "origin", `HEAD:refs/heads/${upstreamBranchName}`])
    }

    /**
     * Creates a snapshot of all worktree changes, including unstaged ones ("shadow ref").
     * Rough equivalent of add -> write-tree -> commit-tree -> update-ref
     * Saved snapshots store a reference to HEAD at the time the snapshot is taken.
     * Accepts only characters that can act as git ref suffix.
     * User's snapshot are automatically prefixed with `loopy/user/`.
     */
    async snapshot(name: string): Promise<void> {
        validateRefSuffix(name)
        await this.snapshotRef(`refs/loopy/user/${name}`)
    }

    /**
     * Restores a given snapshot by checking out stored "HEAD" and applying changes from the "shadow ref".
     * Caution: all uncommitted changes are reset (lost) before restoring the snapshot.
     */
    async restore(snapshotName: string): Promise<void> {
        validateRefSuffix(snapshotName)
        await this.restoreRef(`refs/loopy/user/${snapshotName}`)
    }

    async snapshotRef(fullRef: string): Promise<string> {
        const indexDir = await mkdtemp(path.join(os.tmpdir(), "loopy-index-"))
        try {
            const env = { ...process.env, GIT_INDEX_FILE: path.join(indexDir, "index") }
            await mustGit(this.path, ["add", "-A"], env)
            const tree = (await mustGit(this.path, ["write-tree"], env)).stdout.trim()
            const commit = (
                await mustGit(this.path, ["commit-tree", tree, "-p", "HEAD", "-m", "loopy snapshot"])
            ).stdout.trim()
            await mustGit(this.path, ["update-ref", fullRef, commit])
            return fullRef
        } finally {
            await rm(indexDir, { recursive: true, force: true })
        }
    }

    async restoreRef(fullRef: string): Promise<void> {
        const snapshotSha = (await mustGit(this.path, ["rev-parse", fullRef])).stdout.trim()
        const headSha = (await mustGit(this.path, ["rev-parse", `${fullRef}^`])).stdout.trim()
        await resetTo(this.path, headSha)
        await mustGit(this.path, ["reset", "--hard", snapshotSha])
        await mustGit(this.path, ["reset", "--mixed", headSha])
    }

    async git(args: string[]): Promise<ProcessOutput> {
        return execGit(this.path, args)
    }
}

async function resetTo(cwd: string, ref: string): Promise<void> {
    await mustGit(cwd, ["reset", "--hard"])
    await mustGit(cwd, ["clean", "-fd"])
    await mustGit(cwd, ["checkout", "--detach", ref])
}

function validateRefSuffix(name: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
        throw new Error(`Invalid snapshot name "${name}"; use only letters, digits, ".", "_" and "-"`)
    }
}

function execGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ProcessOutput> {
    return new Promise((resolve) => {
        execFile("git", args, { cwd, env }, (error, stdout, stderr) => {
            const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1
            resolve({ exitCode, stdout, stderr })
        })
    })
}

async function mustGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ProcessOutput> {
    const result = await execGit(cwd, args, env)
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`
        )
    }
    return result
}

export type WorktreeOptions = { base: string; preserve?: boolean; name?: string }

export type ProcessOutput = {
    exitCode: number
    stdout: string
    stderr: string
}
