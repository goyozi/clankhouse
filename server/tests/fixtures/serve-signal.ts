import { loopy as defaultLoopy } from "@loopy/core"
import * as z from "zod"
import { serve } from "../../src"

const instance = defaultLoopy()
instance.registerWorkflow(
    "waiting",
    { input: z.null(), output: z.number(), key: () => "waiting" },
    async () => (await instance.waitFor("never", z.object({ value: z.number() }))).value
)
const runId = instance.start("waiting", null)
const server = await serve(undefined, { port: 0 })
setInterval(() => {}, 1000)
process.stdout.write(`${JSON.stringify({ url: server.url, apiKey: server.apiKey, runId })}\n`)
