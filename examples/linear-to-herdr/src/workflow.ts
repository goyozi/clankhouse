import { clankhouse } from "@clankhouse/core"
import { renderPrompt } from "@clankhouse/core/ai/prompt"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import * as z from "zod"
import type { Herdr } from "./herdr"
import type { Linear, LinearIssue } from "./linear"

export type LinearToHerdrOptions = {
    linear: Linear
    herdr: Herdr
    repositoryPath: string
    agentKind: string
    inProgressState: string
}

export function createLinearToHerdrWorkflow(
    { linear, herdr, repositoryPath, agentKind, inProgressState }: LinearToHerdrOptions,
    instance: ClankHouse = clankhouse()
): (issue: LinearIssue) => Promise<void> {
    return async (issue) => {
        const text = await instance.step("render-prompt", z.string(), () =>
            renderPrompt({ file: prompt("grill"), vars: { issue } })
        )
        await instance.step("open-conversation", z.void(), () =>
            herdr.openConversation({
                cwd: repositoryPath,
                name: issue.identifier.toLowerCase(),
                label: issue.identifier,
                kind: agentKind,
                prompt: text
            })
        )
        await instance.step("move-to-in-progress", z.void(), () => linear.moveIssue(issue, inProgressState))
    }
}

function prompt(name: string): URL {
    return new URL(`prompts/${name}.md`, import.meta.url)
}
