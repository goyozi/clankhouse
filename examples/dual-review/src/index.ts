import { randomUUID } from "node:crypto"
import { ClaudeAgent } from "@clankhouse/claude"
import { CodexAgent } from "@clankhouse/codex"
import { registerWorkflow } from "@clankhouse/core"
import { serve } from "@clankhouse/server"
import * as z from "zod"
import { createDualReviewWorkflow } from "./workflow"

const reviewer2Options = { model: "gpt-5.6-sol", modelReasoningEffort: "xhigh" } as const
const workflow = createDualReviewWorkflow({
    reviewer1: new ClaudeAgent({ model: "claude-opus-5", effort: "medium" }),
    reviewer2: new CodexAgent(reviewer2Options),
    synthesizer: new CodexAgent(reviewer2Options)
})

registerWorkflow(
    "dual-review",
    {
        input: z.object({ repositoryPath: z.string() }),
        output: z.string(),
        key: () => randomUUID()
    },
    workflow
)

const server = await serve()
console.log(`ClankHouse dual-review server listening at ${server.url}`)
