import { randomUUID } from "node:crypto"
import { CodexAgent } from "@clankhouse/codex"
import { registerWorkflow } from "@clankhouse/core"
import { serve } from "@clankhouse/server"
import * as z from "zod"
import { createHelloWorldWorkflow } from "./workflow"

const workflow = createHelloWorldWorkflow(new CodexAgent({ model: "gpt-5.6-luna" }))
registerWorkflow(
    "hello-world",
    {
        input: z.void(),
        output: z.string(),
        key: () => randomUUID()
    },
    workflow
)

const server = await serve()
console.log(`ClankHouse hello-world server listening at ${server.url}`)
