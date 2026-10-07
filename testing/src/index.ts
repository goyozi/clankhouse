import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { onTestFinished } from "vitest"
import { ClankHouse } from "@clankhouse/core/clankhouse"
import type { WorkflowRun } from "@clankhouse/core/runs"
import * as z from "zod"

export * from "./fake-agent.js"
export * from "./fake-llm.js"

const execFileAsync = promisify(execFile)

export function tempDir(prefix: string): string {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

export function tempClankHouse(): { clankhouse: ClankHouse; dir: string; reopen: () => ClankHouse } {
    const dir = tempDir("clankhouse-test-")
    const instances: ClankHouse[] = []
    const open = () => {
        const instance = new ClankHouse(dir)
        instances.push(instance)
        return instance
    }
    const clankhouse = open()
    onTestFinished(() => {
        for (const instance of instances) {
            try {
                instance.close()
            } catch {}
        }
    })
    return { clankhouse, dir, reopen: open }
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd })
    return stdout.trim()
}

export type TempGitRepo = {
    path: string
    write: (file: string, content: string) => void
    read: (file: string) => string
    exists: (file: string) => boolean
    commitAll: (message: string) => Promise<void>
    addBareOrigin: () => Promise<string>
}

export async function tempGitRepo(): Promise<TempGitRepo> {
    const dir = tempDir("clankhouse-git-")
    await runGit(dir, ["init", "-b", "main"])
    await runGit(dir, ["config", "core.autocrlf", "false"])
    await runGit(dir, ["config", "user.email", "test@clankhouse.dev"])
    await runGit(dir, ["config", "user.name", "ClankHouse Test"])
    const repo: TempGitRepo = {
        path: dir,
        write(file, content) {
            const target = path.join(dir, file)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, content)
        },
        read: (file) => fs.readFileSync(path.join(dir, file), "utf8"),
        exists: (file) => fs.existsSync(path.join(dir, file)),
        async commitAll(message) {
            await runGit(dir, ["add", "-A"])
            await runGit(dir, ["commit", "-m", message])
        },
        async addBareOrigin() {
            const bare = tempDir("clankhouse-origin-")
            await runGit(bare, ["init", "--bare"])
            await runGit(dir, ["remote", "add", "origin", bare])
            return bare
        }
    }
    repo.write("README.md", "# test\n")
    await repo.commitAll("initial")
    return repo
}

export function testRun<O>(
    clankhouse: ClankHouse,
    body: () => Promise<O>,
    opts: { key?: string; output?: z.ZodType<O> } = {}
): Promise<O> {
    const output = opts.output ?? (z.json() as unknown as z.ZodType<O>)
    return clankhouse.run("test-workflow", opts.key ?? "test-key", output, body)
}

export async function waitForRun(clankhouse: ClankHouse, runId: string): Promise<WorkflowRun> {
    let run = await clankhouse.runs.get(runId)
    while (run.status !== "succeeded" && run.status !== "failed" && run.status !== "canceled") {
        await delay(5)
        run = await clankhouse.runs.get(runId)
    }
    return run
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runOutput(clankhouse: ClankHouse, runId: string): Promise<unknown> {
    const run = await waitForRun(clankhouse, runId)
    if (run.status === "failed") throw new Error(run.error)
    return run.output
}

export function gate(): { released: Promise<void>; release: () => void } {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
        release = resolve
    })
    return { released, release }
}
