import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { clankhouse as defaultClankHouse } from "@clankhouse/core"
import type { CodingAgent } from "@clankhouse/core/ai/coding-agent"
import { GitRepository } from "@clankhouse/core/git"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import * as z from "zod"

const execFileAsync = promisify(execFile)
const prompt = 'Create a Python program in hello.py that prints exactly "Hello, World!" when run.'

export function createHelloWorldWorkflow(
    agent: CodingAgent,
    instance: ClankHouse = defaultClankHouse()
): () => Promise<string> {
    return async () => {
        const directory = await instance.step("create-repository", z.string(), createRepository)
        const repository = new GitRepository(directory)
        const worktree = await repository.worktree({ base: "HEAD" })
        await agent.run("implement", {
            prompt,
            output: z.void(),
            worktree
        })
        await repository.applyChanges(worktree)
        return directory
    }
}

async function createRepository(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "clankhouse-hello-world-"))
    try {
        await runGit(directory, ["init", "-b", "main"])
        await runGit(directory, ["config", "core.autocrlf", "false"])
        await runGit(directory, ["config", "user.email", "hello-world@clankhouse.local"])
        await runGit(directory, ["config", "user.name", "ClankHouse Hello World"])
        await runGit(directory, ["commit", "--allow-empty", "-m", "Initial commit"])
        return directory
    } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => {})
        throw error
    }
}

async function runGit(directory: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd: directory })
}
