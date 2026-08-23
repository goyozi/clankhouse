import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { onTestFinished } from "vitest"
import { Loopy } from "@loopy/core/loopy"
import type { WorkflowRun } from "@loopy/core/runs"
import type { AISessionMessage } from "@loopy/core/ai/sessions"
import * as z from "zod"

const execFileAsync = promisify(execFile)

export function tempDir(prefix: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

export function tempLoopy(): { loopy: Loopy; dir: string; reopen: () => Loopy } {
    const dir = tempDir("loopy-test-")
    const instances: Loopy[] = []
    const open = () => {
        const instance = new Loopy(dir)
        instances.push(instance)
        return instance
    }
    const loopy = open()
    onTestFinished(() => {
        for (const instance of instances) {
            try {
                instance.close()
            } catch {}
        }
    })
    return { loopy, dir, reopen: open }
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
    const dir = tempDir("loopy-git-")
    await runGit(dir, ["init", "-b", "main"])
    await runGit(dir, ["config", "core.autocrlf", "false"])
    await runGit(dir, ["config", "user.email", "test@loopy.dev"])
    await runGit(dir, ["config", "user.name", "Loopy Test"])
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
            const bare = tempDir("loopy-origin-")
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
    loopy: Loopy,
    body: () => Promise<O>,
    opts: { key?: string; output?: z.ZodType<O> } = {}
): Promise<O> {
    const output = opts.output ?? (z.json() as unknown as z.ZodType<O>)
    return loopy.run("test-workflow", opts.key ?? "test-key", output, body)
}

export async function waitForRun(loopy: Loopy, runId: string): Promise<WorkflowRun> {
    let run = await loopy.runs.get(runId)
    while (run.status !== "succeeded" && run.status !== "failed") {
        await delay(5)
        run = await loopy.runs.get(runId)
    }
    return run
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runOutput(loopy: Loopy, runId: string): Promise<unknown> {
    const run = await waitForRun(loopy, runId)
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

export function instructedTags(prompt: string): { name: string; opening: string; closing: string } {
    const match = prompt.match(/<(loopy_structured_output_[0-9a-f_]+)>/)
    if (match === null) throw new Error("prompt has no instructed output tags")
    return { name: match[1], opening: `<${match[1]}>`, closing: `</${match[1]}>` }
}

export function instructedSchema(prompt: string): unknown {
    const startMarker = "```json\n"
    const start = prompt.indexOf(startMarker)
    const end = prompt.indexOf("\n```", start + startMarker.length)
    if (start === -1 || end === -1) throw new Error("prompt has no instructed output schema")
    return JSON.parse(prompt.slice(start + startMarker.length, end))
}

export function taggedOutput(prompt: string, outputText: string): string {
    const { opening, closing } = instructedTags(prompt)
    return `${opening}\n${outputText}\n${closing}`
}

export function taggedStringOutput(prompt: string, outputText: string): string {
    const { opening, closing } = instructedTags(prompt)
    return `${opening}${outputText}${closing}`
}

export function sessionTextMessages(
    messages: AISessionMessage[]
): Array<Extract<AISessionMessage, { type: "message" }>> {
    return messages.filter(
        (message): message is Extract<AISessionMessage, { type: "message" }> => message.type === "message"
    )
}

export function sessionToolCallMessages(
    messages: AISessionMessage[]
): Array<Extract<AISessionMessage, { type: "tool_call" }>> {
    return messages.filter(
        (message): message is Extract<AISessionMessage, { type: "tool_call" }> => message.type === "tool_call"
    )
}
