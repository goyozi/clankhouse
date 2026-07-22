import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { BaseCodingAgent, type CodingAgentInvocation } from "./base-agent"
import { LoopyError } from "../errors"

export type FakeWrite = {
    file: string
    text: string
}

export type FakeEdit = {
    file: string
    oldText: string
    newText: string
}

export type FakeDelete = {
    file: string
}

export type FakeChange = FakeWrite | FakeEdit | FakeDelete

export type FakeAgentResult = {
    changes: FakeChange[]
    output: unknown
}

export async function applyChange(change: FakeChange, baseDir: string): Promise<void> {
    const target = path.join(baseDir, change.file)
    if ("text" in change) {
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, change.text)
    } else if ("oldText" in change) {
        const content = await readFile(target, "utf8")
        if (!content.includes(change.oldText)) {
            throw new LoopyError("fake_agent_edit_text_not_found", `oldText not found in ${change.file}`)
        }
        await writeFile(
            target,
            content.replace(change.oldText, () => change.newText)
        )
    } else {
        await rm(target)
    }
}

export class FakeCodingAgent extends BaseCodingAgent {
    readonly provider = "fake-agent"
    readonly model = "fake"
    private readonly fakeRun: (stepName: string, prompt: string) => FakeAgentResult

    constructor(fakeRun: (stepName: string, prompt: string) => FakeAgentResult) {
        super()
        this.fakeRun = fakeRun
    }

    protected async invoke({ stepName, prompt, worktree, session }: CodingAgentInvocation): Promise<unknown> {
        session.addMessage("user", prompt)
        const result = this.fakeRun(stepName, prompt)
        for (const change of result.changes) {
            await applyChange(change, worktree.path)
            session.addMessage("tool", JSON.stringify(change))
        }
        session.addMessage("assistant", JSON.stringify(result.output))
        return result.output
    }
}
