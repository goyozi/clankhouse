import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ClankHouseError, clankhouse } from "@clankhouse/core"
import { serve } from "@clankhouse/server"
import * as z from "zod"
import { HerdrCli } from "./herdr"
import { LinearClient, LinearIssue, linearIssues } from "./linear"
import { createLinearToHerdrWorkflow } from "./workflow"

const SETTLED_RUN_ERRORS = new Set(["workflow_run_failed", "workflow_run_canceled", "workflow_run_deleted"])

const expandHome = (value: string) => value.replace(/^~(?=$|\/)/, os.homedir())

const Env = z.object({
    LINEAR_API_KEY: z.string(),
    REPOSITORY_PATH: z.string().transform((value) => path.resolve(expandHome(value))),
    AGENT: z.string().default("claude"),
    LINEAR_TEAM: z.string().optional(),
    HERDR_SESSION_ID: z.string().optional(),
    AGENT_ENV: z.string().default("").transform(agentEnv)
})

function agentEnv(names: string, ctx: z.RefinementCtx): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)) {
        const value = process.env[name]
        if (!value) ctx.addIssue({ code: "custom", message: `${name} is listed but not set` })
        else env[name] = expandHome(value)
    }
    return env
}

function parseEnv(): z.infer<typeof Env> {
    if (fs.existsSync(".env")) process.loadEnvFile()
    const result = Env.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== "")))
    if (result.success) return result.data
    console.error(z.prettifyError(result.error))
    console.error("copy .env.example to .env and fill it in")
    process.exit(2)
}

const env = parseEnv()

const linear = new LinearClient(env.LINEAR_API_KEY)
const workflow = createLinearToHerdrWorkflow({
    linear,
    herdr: new HerdrCli(env.HERDR_SESSION_ID, env.AGENT_ENV),
    repositoryPath: env.REPOSITORY_PATH,
    agentKind: env.AGENT,
    inProgressState: "In Progress"
})

const linearToHerdr = clankhouse().registerWorkflow(
    "linear-to-herdr",
    { input: LinearIssue, output: z.void(), key: (issue) => issue.id },
    workflow
)
clankhouse().addTrigger(
    linearIssues(linear, { state: "Todo", team: env.LINEAR_TEAM, intervalMs: 60_000 }),
    linearToHerdr,
    {
        onError: (error) => {
            if (error instanceof ClankHouseError && SETTLED_RUN_ERRORS.has(error.code)) return
            console.error("Linear trigger error", error)
        }
    }
)

const server = await serve()
console.log(`ClankHouse linear-to-herdr listening at ${server.url}, opening conversations in ${env.REPOSITORY_PATH}`)
