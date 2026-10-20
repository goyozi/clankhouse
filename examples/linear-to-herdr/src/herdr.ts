import { execFile } from "node:child_process"
import { promisify } from "node:util"

export type ConversationOptions = {
    cwd: string
    name: string
    label: string
    kind: string
    prompt: string
}

export interface Herdr {
    openConversation(options: ConversationOptions): Promise<void>
}

type WorkspaceCreated = { result: { root_pane: { pane_id: string } } }

const execFileAsync = promisify(execFile)

export class HerdrCli implements Herdr {
    private readonly sessionId: string | undefined
    private readonly env: Record<string, string>

    constructor(sessionId?: string, env: Record<string, string> = {}) {
        this.sessionId = sessionId
        this.env = env
    }

    async openConversation({ cwd, name, label, kind, prompt }: ConversationOptions): Promise<void> {
        const workspace = await this.herdr<WorkspaceCreated>([
            "workspace",
            "create",
            "--cwd",
            cwd,
            "--label",
            label,
            "--no-focus",
            ...Object.entries(this.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])
        ])
        await this.herdr(["agent", "start", name, "--kind", kind, "--pane", workspace.result.root_pane.pane_id])
        await this.herdr(["agent", "prompt", name, prompt])
    }

    private async herdr<T = unknown>(args: string[]): Promise<T> {
        const session = this.sessionId === undefined ? [] : ["--session", this.sessionId]
        try {
            const { stdout } = await execFileAsync("herdr", [...session, ...args])
            return JSON.parse(stdout) as T
        } catch (error) {
            const stderr = (error as { stderr?: string }).stderr?.trim()
            const detail = stderr || (error instanceof Error ? error.message : String(error))
            throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${detail}`, { cause: error })
        }
    }
}
