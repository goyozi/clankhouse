import { ClaudeAgent } from "@clankhouse/claude"
import { CodexAgent } from "@clankhouse/codex"
import { clankhouse } from "@clankhouse/core"
import { serve } from "@clankhouse/server"
import * as z from "zod"
import { watchTasks } from "./tasks"
import { createFactoryWorkflow, FactoryInput } from "./workflow"

const repositories = process.argv.slice(2)
if (repositories.length === 0) {
    console.error("usage: pnpm start <repository-path>...")
    process.exit(2)
}

const claude = (effort: "medium" | "high") => new ClaudeAgent({ model: "claude-opus-5-5", effort })
const codex = (modelReasoningEffort: "medium" | "xhigh") =>
    new CodexAgent({ model: "gpt-5.6-sol", modelReasoningEffort })

const workflow = createFactoryWorkflow({
    implementer: claude("medium"),
    codeReviewer1: claude("medium"),
    codeReviewer2: codex("xhigh"),
    codeReviewSynthesizer: codex("xhigh"),
    fixer: claude("medium"),
    applicationTester: claude("medium")
})

const factory = clankhouse().registerWorkflow(
    "factory",
    { input: FactoryInput, output: z.void(), key: ({ task }) => task },
    workflow
)
for (const repository of repositories) watchTasks(clankhouse(), repository, factory)

const server = await serve()
console.log(`ClankHouse factory listening at ${server.url}, watching ${repositories.join(", ")}`)
