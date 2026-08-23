import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { CodexAgent } from "@loopy/codex"
import { GitRepository, Worktree } from "@loopy/core/git"
import { uniqueName } from "@loopy/core/util"
import {
    instructedSchema,
    instructedTags,
    runGit,
    runOutput,
    sessionTextMessages,
    taggedOutput,
    taggedStringOutput,
    tempGitRepo,
    tempLoopy,
    testRun
} from "@loopy/test-utils"
import { fakeCodex } from "./fake-codex-sdk"

const outputSchema = z.object({ done: z.boolean() })
const workflowOptions = { input: z.null(), output: z.json(), key: () => "test-key" }
const liveOutputSchema = z.array(
    z.discriminatedUnion("kind", [
        z.object({
            kind: z.literal("file"),
            path: z.string(),
            lineCount: z.number().int(),
            note: z.string().optional()
        }),
        z.object({ kind: z.literal("status"), done: z.boolean(), warning: z.string().optional() })
    ])
)

test("CodexAgent maps the SDK conversation to the session and snapshots the worktree", async () => {
    // given a fake SDK scripted with reasoning, a file change and structured output
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({
        items: [
            {
                started: { id: "reason_1", type: "reasoning", text: "I should add the requested file." }
            },
            {
                completed: {
                    id: "change_1",
                    type: "file_change",
                    changes: [{ path: "src/hello.ts", kind: "add" }],
                    status: "completed"
                },
                change: { file: "src/hello.ts", text: "export const hi = 1\n" }
            }
        ],
        output: { done: true }
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })
    let worktree!: Worktree

    // when the agent runs inside a durable step
    const result = await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then it returns structured output and applies the file change
    expect(result).toEqual({ done: true })
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
    // and the durable step stores a valid worktree snapshot
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    expect(step.kind).toBe("agent")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect(step.snapshotRef).toBe(
        `refs/loopy/agent/${uniqueName("test-workflow/test-key")}/1/${uniqueName("implement")}`
    )
    expect((await worktree.git(["rev-parse", step.snapshotRef!])).exitCode).toBe(0)
    // and the session records client and provider metadata and the normalized conversation
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.client).toBe("codex")
    expect(session.provider).toBe("openai")
    expect(session.model).toBe("gpt-5.4")
    expect(session.status).toBe("succeeded")
    expect(session.messages.map((item) => (item.type === "message" ? item.role : item.type))).toEqual([
        "user",
        "system",
        "reasoning",
        "tool_call",
        "tool_result",
        "assistant"
    ])
    const messages = sessionTextMessages(session.messages)
    expect(messages[0].content).toMatch(/^do it\n\nIMPORTANT — requested final report:/)
    expect(JSON.parse(messages[1].content)).toEqual({
        threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        model: "gpt-5.4"
    })
    expect(messages[2].content).toBe("I should add the requested file.")
    expect(session.messages[3]).toMatchObject({
        toolCall: {
            id: "change_1",
            name: "file_change",
            source: { kind: "native" },
            input: { changes: [{ path: "src/hello.ts", kind: "add" }] },
            common: { name: "file.change", paths: ["src/hello.ts"] }
        }
    })
    // and the final agent message is recorded once, verbatim, with no re-stringified duplicate
    expect(messages.at(-1)!.content).toBe(taggedOutput(messages[0].content, JSON.stringify({ done: true })))
})

test("CodexAgent runs a void-output step without instructed output framing", async () => {
    // given a fake SDK that applies a file change and returns no structured output
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory, runCalls } = fakeCodex(() => ({
        items: [
            {
                completed: {
                    id: "change_1",
                    type: "file_change",
                    changes: [{ path: "src/hello.ts", kind: "add" }],
                    status: "completed"
                },
                change: { file: "src/hello.ts", text: "export const hi = 1\n" }
            }
        ]
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })
    let worktree!: Worktree

    // when the agent runs with a void output schema
    const result = await testRun(
        loopy,
        async () => {
            worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: z.void(), worktree })
        },
        { output: z.void() }
    )

    // then it returns nothing and the SDK receives the bare prompt with no output framing
    expect(result).toBeUndefined()
    expect(runCalls[0].input).toBe("do it")
    // and the coding work is applied and the step and session still succeed with a snapshot
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await worktree.git(["rev-parse", step.snapshotRef!])).exitCode).toBe(0)
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("succeeded")
})

test("CodexAgent returns an earlier tagged string after an untagged monitor message", async () => {
    // given a fake SDK emitting a tagged answer before a final monitor notification
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const worktree = new Worktree(repo.path)
    const answer = "  All 8 issues stand as written.  "
    const monitorMessage = "The monitor resolved; there is nothing else to add."
    const { codexFactory, runCalls } = fakeCodex((prompt) => ({
        items: [
            {
                completed: {
                    id: "agent_answer",
                    type: "agent_message",
                    text: taggedStringOutput(prompt, answer)
                }
            }
        ],
        finalResponse: monitorMessage
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs with a checked and branded root string schema
    const result = await testRun(loopy, () =>
        agent.run("report", {
            prompt: "report naturally",
            output: z.string().min(1).brand<"AgentReport">(),
            worktree
        })
    )

    // then the SDK receives the dedicated string instruction and the tagged answer is returned
    expect(runCalls[0].input).toMatch(/^report naturally\n\nIMPORTANT — requested final answer:/)
    expect(runCalls[0].input).not.toMatch(/JSON/i)
    expect(result).toBe(answer)
    // and both assistant messages remain recorded while only the extracted answer is persisted
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    expect(step.outputJson).toBe(JSON.stringify(answer))
    const messages = sessionTextMessages((await loopy.sessions.get(step.sessionId!)).messages)
    expect(messages.slice(-2).map((message) => message.content)).toEqual([
        taggedStringOutput(String(runCalls[0].input), answer),
        monitorMessage
    ])
})

test("CodexAgent records every supported SDK item type", async () => {
    // given a fake SDK stream containing each supported item and an ignored update
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({
        items: [
            { started: { id: "reason_1", type: "reasoning", text: "Checking the repository." } },
            {
                started: {
                    id: "command_1",
                    type: "command_execution",
                    command: "pnpm test",
                    aggregated_output: "",
                    status: "in_progress"
                },
                updates: [
                    {
                        id: "command_1",
                        type: "command_execution",
                        command: "pnpm test",
                        aggregated_output: "running",
                        status: "in_progress"
                    }
                ],
                completed: {
                    id: "command_1",
                    type: "command_execution",
                    command: "pnpm test",
                    aggregated_output: "passed",
                    exit_code: 0,
                    status: "completed"
                }
            },
            {
                completed: {
                    id: "change_1",
                    type: "file_change",
                    changes: [{ path: "a.ts", kind: "update" }],
                    status: "completed"
                }
            },
            {
                started: {
                    id: "mcp_1",
                    type: "mcp_tool_call",
                    server: "docs",
                    tool: "lookup",
                    arguments: { key: "value" },
                    status: "in_progress"
                },
                completed: {
                    id: "mcp_1",
                    type: "mcp_tool_call",
                    server: "docs",
                    tool: "lookup",
                    arguments: { key: "value" },
                    error: { message: "docs unavailable" },
                    status: "failed"
                }
            },
            { started: { id: "search_1", type: "web_search", query: "loopy" } },
            {
                started: {
                    id: "todo_1",
                    type: "todo_list",
                    items: [{ text: "Inspect", completed: false }]
                },
                completed: {
                    id: "todo_1",
                    type: "todo_list",
                    items: [{ text: "Inspect", completed: true }]
                }
            },
            { started: { id: "error_1", type: "error", message: "optional tool unavailable" } }
        ],
        output: { done: true }
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    await testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then every completed item is recorded once and the update adds no duplicate
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.messages.map((item) => (item.type === "message" ? item.role : item.type))).toEqual([
        "user",
        "system",
        "reasoning",
        "tool_call",
        "tool_result",
        "tool_call",
        "tool_result",
        "tool_call",
        "tool_result",
        "tool_call",
        "tool_result",
        "assistant",
        "system",
        "assistant"
    ])
    // and tool starts carry stable ids, normalized names, sources and inputs
    expect(session.messages[3]).toMatchObject({
        toolCall: {
            id: "command_1",
            name: "command_execution",
            source: { kind: "native" },
            input: { command: "pnpm test" },
            common: { name: "shell.execute", command: "pnpm test" }
        }
    })
    expect(session.messages[5]).toMatchObject({
        toolCall: {
            id: "change_1",
            common: { name: "file.change", paths: ["a.ts"] }
        }
    })
    expect(session.messages[7]).toMatchObject({
        toolCall: {
            id: "mcp_1",
            name: "lookup",
            source: { kind: "mcp", server: "docs" },
            input: { key: "value" }
        }
    })
    expect(session.messages[9]).toMatchObject({
        toolCall: {
            id: "search_1",
            name: "web_search",
            source: { kind: "provider" },
            input: { query: "loopy" },
            common: { name: "web.search", query: "loopy" }
        }
    })
    // and tool completions preserve the authoritative completed item
    expect(session.messages[4]).toMatchObject({
        toolResult: {
            toolCallId: "command_1",
            status: "succeeded",
            output: {
                id: "command_1",
                type: "command_execution",
                command: "pnpm test",
                aggregated_output: "passed",
                exit_code: 0,
                status: "completed"
            }
        }
    })
    expect(session.messages[8]).toMatchObject({
        toolResult: {
            toolCallId: "mcp_1",
            status: "failed",
            error: "docs unavailable"
        }
    })
    expect(session.messages[11]).toMatchObject({
        content: JSON.stringify({ todoList: [{ text: "Inspect", completed: true }] })
    })
    expect(session.messages[12]).toMatchObject({ content: JSON.stringify({ error: "optional tool unavailable" }) })
})

test("CodexAgent records a no-argument MCP call without failing the run", async () => {
    // given a Codex MCP item whose no-argument payload is absent
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const worktree = new Worktree(repo.path)
    const { codexFactory } = fakeCodex(() => ({
        items: [
            {
                started: {
                    id: "mcp_noop_1",
                    type: "mcp_tool_call",
                    server: "tools",
                    tool: "noop",
                    arguments: undefined,
                    status: "in_progress"
                },
                completed: {
                    id: "mcp_noop_1",
                    type: "mcp_tool_call",
                    server: "tools",
                    tool: "noop",
                    arguments: undefined,
                    result: { content: [], structured_content: null },
                    status: "completed"
                }
            }
        ],
        output: { done: true }
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs the tool and completes the turn
    await testRun(loopy, () => agent.run("implement", { prompt: "do it", output: outputSchema, worktree }))

    // then the call is durable with a JSON null input and the session succeeds
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.status).toBe("succeeded")
    expect(session.messages.find((item) => item.type === "tool_call")).toMatchObject({
        toolCall: { id: "mcp_noop_1", input: null }
    })
})

test("CodexAgent passes locked default options to the SDK", async () => {
    // given a codex agent configured with only a model and fake factory
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory, clientOptions, threadOptions, runCalls } = fakeCodex(() => ({
        output: { done: true }
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })
    let worktree!: Worktree

    // when the agent runs
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the client inherits its native defaults
    expect(clientOptions).toEqual([{}])
    const prompt = runCalls[0].input
    if (typeof prompt !== "string") throw new Error("unreachable")
    const { opening, closing } = instructedTags(prompt)
    const jsonSchema = {
        type: "object",
        properties: { done: { type: "boolean" } },
        required: ["done"]
    }
    // and the thread is locked to the worktree without approvals or generated output directories
    expect(threadOptions).toEqual([
        {
            model: "gpt-5.4",
            workingDirectory: worktree.path,
            sandboxMode: "workspace-write",
            approvalPolicy: "never"
        }
    ])
    // and the rendered prompt carries nonce tags and JSON schema instead of native turn options
    expect(runCalls).toHaveLength(1)
    expect(prompt).toBe(`do it

IMPORTANT — requested final report:

When you are done, put a final JSON report between these exact tags in your final response:

${opening}
${closing}

The JSON must conform to this JSON Schema:

\`\`\`json
${JSON.stringify(jsonSchema, null, 2)}
\`\`\`
Write only raw JSON between the tags — no markdown fences, no comments, no surrounding prose.
You may include prose outside the tags.`)
    expect(instructedSchema(prompt)).toEqual(jsonSchema)
    expect(runCalls[0].options).toBeUndefined()
})

test("CodexAgent forwards every configured native SDK option", async () => {
    // given a codex agent configured with every supported client and thread option
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory, clientOptions, threadOptions, runCalls } = fakeCodex(() => ({
        output: { done: true }
    }))
    const agent = new CodexAgent({
        model: "gpt-5.4",
        sandboxMode: "danger-full-access",
        approvalPolicy: "untrusted",
        modelReasoningEffort: "high",
        networkAccessEnabled: true,
        webSearchMode: "live",
        additionalDirectories: ["/tmp/extra"],
        codexPathOverride: "/opt/codex",
        baseUrl: "https://example.test",
        apiKey: "test-key",
        config: { show_raw_agent_reasoning: true },
        codexFactory
    })
    let worktree!: Worktree

    // when the agent runs
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then every configured client option is forwarded to the SDK
    expect(clientOptions).toEqual([
        {
            codexPathOverride: "/opt/codex",
            baseUrl: "https://example.test",
            apiKey: "test-key",
            config: { show_raw_agent_reasoning: true }
        }
    ])
    const prompt = runCalls[0].input
    if (typeof prompt !== "string") throw new Error("unreachable")
    // and every configured thread option is forwarded beside the derived worktree path
    expect(threadOptions).toEqual([
        {
            model: "gpt-5.4",
            workingDirectory: worktree.path,
            sandboxMode: "danger-full-access",
            approvalPolicy: "untrusted",
            modelReasoningEffort: "high",
            networkAccessEnabled: true,
            webSearchMode: "live",
            additionalDirectories: ["/tmp/extra"]
        }
    ])
})

test("CodexAgent augments the process environment with the configured env", async () => {
    // given process env entries and an agent that overrides one and adds another
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory, clientOptions } = fakeCodex(() => ({ output: { done: true } }))
    const previousInherited = process.env.LOOPY_CODEX_INHERITED
    const previousOverridden = process.env.LOOPY_CODEX_OVERRIDDEN
    process.env.LOOPY_CODEX_INHERITED = "from-process"
    process.env.LOOPY_CODEX_OVERRIDDEN = "from-process"
    const agent = new CodexAgent({
        model: "gpt-5.4",
        env: { LOOPY_CODEX_OVERRIDDEN: "from-agent", LOOPY_CODEX_ADDED: "from-agent" },
        codexFactory
    })

    // when the agent runs
    try {
        await testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    } finally {
        if (previousInherited === undefined) delete process.env.LOOPY_CODEX_INHERITED
        else process.env.LOOPY_CODEX_INHERITED = previousInherited
        if (previousOverridden === undefined) delete process.env.LOOPY_CODEX_OVERRIDDEN
        else process.env.LOOPY_CODEX_OVERRIDDEN = previousOverridden
    }

    // then the subprocess environment inherits unrelated process variables
    expect(clientOptions[0].env!.LOOPY_CODEX_INHERITED).toBe("from-process")
    // and the configured entries override matching keys and extend the rest
    expect(clientOptions[0].env!.LOOPY_CODEX_OVERRIDDEN).toBe("from-agent")
    expect(clientOptions[0].env!.LOOPY_CODEX_ADDED).toBe("from-agent")
})

test("CodexAgent includes format annotations and recursive references in the instructed schema", async () => {
    // given a recursive Zod output schema with a format-annotated field
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory, runCalls } = fakeCodex(() => ({
        output: { contact: "bob@example.com", children: [] }
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })
    const category: z.ZodType = z.lazy(() => z.object({ contact: z.email(), children: z.array(category) }))

    // when the agent runs against the schema
    const result = await testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("report", { prompt: "report", output: category, worktree })
    })

    // then the structured result is returned
    expect(result).toEqual({ contact: "bob@example.com", children: [] })
    // and only the schema metadata is removed while JSON Schema keywords remain in the prompt
    const prompt = runCalls[0].input
    if (typeof prompt !== "string") throw new Error("unreachable")
    const schema = instructedSchema(prompt) as {
        $schema?: string
        properties: { contact: { format?: string }; children: { items: { $ref?: string } } }
    }
    expect(schema.$schema).toBeUndefined()
    expect(schema.properties.contact.format).toBe("email")
    expect(schema.properties.children.items.$ref).toBe("#")
})

test("a non-JSON-representable output schema fails before starting a Codex thread", async () => {
    // given an output schema containing a Date
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory, threadOptions, runCalls } = fakeCodex(() => ({ output: { done: true } }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs with the unrepresentable schema
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", {
                prompt: "do it",
                output: z.object({ when: z.date() }),
                worktree
            })
        })
    ).rejects.toThrow(/Coding agent "implement" output schema.*when z\.date\(\)/)

    // then the SDK thread and turn are never started
    expect(threadOptions).toHaveLength(0)
    expect(runCalls).toHaveLength(0)
    // and no agent step or session was created
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    expect(run.steps.filter((step) => step.kind === "agent")).toHaveLength(0)
    expect(loopy.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 })
})

test("a failed Codex turn fails the durable step and preserves recorded messages", async () => {
    // given a fake SDK that reasons before returning a failed turn
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({
        items: [{ started: { id: "reason_1", type: "reasoning", text: "Still trying." } }],
        turnFailure: "model exhausted its context"
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    ).rejects.toThrow("Codex agent failed: model exhausted its context")

    // then the step and session fail with earlier messages preserved
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.status).toBe("failed")
    expect(sessionTextMessages(session.messages).map((item) => item.role)).toEqual(["user", "system", "reasoning"])
})

test("a fatal Codex stream event fails the durable step", async () => {
    // given a fake SDK that emits a fatal stream error
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({
        items: [
            {
                started: {
                    id: "command_interrupted",
                    type: "command_execution",
                    command: "pnpm test",
                    aggregated_output: "",
                    status: "in_progress"
                },
                complete: false
            }
        ],
        streamError: "connection lost"
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the fatal event is surfaced as a provider error
    await expect(result).rejects.toThrow("Codex agent stream error: connection lost")
    // and the started tool remains durable without a synthetic completion
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.messages.filter((item) => item.type === "tool_call")).toHaveLength(1)
    expect(session.messages.filter((item) => item.type === "tool_result")).toHaveLength(0)
})

test("a thrown SDK stream error fails the step and preserves initialization", async () => {
    // given a fake SDK that throws after starting the thread
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({ throwMidStream: new Error("process exited unexpectedly") }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    ).rejects.toThrow("process exited unexpectedly")

    // then the failed session preserves the prompt and thread metadata
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.status).toBe("failed")
    expect(sessionTextMessages(session.messages).map((item) => item.role)).toEqual(["user", "system"])
})

test("a stream ending without turn completion fails the step", async () => {
    // given a fake SDK that emits output but no turn completion
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({ output: { done: true }, endWithoutCompletion: true }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the premature end is rejected
    await expect(result).rejects.toThrow("Codex agent stream ended without completing the turn")
})

test("an untagged final agent response fails the step", async () => {
    // given a fake SDK that replies with plain JSON without the instructed tags
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({ finalResponse: JSON.stringify({ done: true }) }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the missing tags are rejected
    await expect(result).rejects.toThrow("AI did not return the instructed output tags")
})

test("invalid JSON inside the instructed tags fails the step", async () => {
    // given a fake SDK returning plain text inside the instructed tags
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex((prompt) => {
        const { opening, closing } = instructedTags(prompt)
        return { finalResponse: `${opening}\nall done\n${closing}` }
    })
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the invalid JSON is rejected
    await expect(result).rejects.toThrow("returned invalid JSON between the instructed output tags")
})

test("Codex output fails when the turn has no final agent message", async () => {
    // given a Codex agent whose turn completes without an agent message
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({}))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("report", { prompt: "report", output: outputSchema, worktree })
    })

    // then the missing tagged report fails the durable step and session
    await expect(result).rejects.toThrow("did not return the instructed output tags")
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
})

test("structured output violating the Zod schema fails the step", async () => {
    // given a fake SDK returning valid JSON with the wrong field type
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({ output: { done: "yes" } }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    ).rejects.toThrow()

    // then the engine marks the step and session failed after final validation
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
})

test("codex agent step replay restores the worktree without re-invoking the SDK", async () => {
    // given a codex agent backed by a fake SDK and a later failing step
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory, runCalls } = fakeCodex(() => ({
        items: [
            {
                completed: {
                    id: "change_1",
                    type: "file_change",
                    changes: [{ path: "src/hello.ts", kind: "add" }],
                    status: "completed"
                },
                change: { file: "src/hello.ts", text: "export const hi = 1\n" }
            }
        ],
        output: { done: true }
    }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })
    let publishImpl: () => string = () => {
        throw new Error("boom")
    }
    let worktree!: Worktree
    const body = async () => {
        worktree = await repository.worktree({ base: "main" })
        await agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        return loopy.step("publish", z.string(), async () => publishImpl())
    }
    loopy.registerWorkflow("test-workflow", workflowOptions, body)

    // when the workflow fails after the agent and its changes are discarded
    const firstId = loopy.start("test-workflow", null)
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])
    // and the workflow reruns from the later step
    publishImpl = () => "published"
    const secondId = loopy.rerun(firstId, { from: "publish" })
    expect(await runOutput(loopy, secondId)).toBe("published")

    // then the SDK ran once and the stored snapshot restored the change
    expect(runCalls).toHaveLength(1)
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
})

test.skipIf(!process.env.CODEX_AGENT_LIVE_TEST)(
    "live: CodexAgent performs a coding task with non-trivial output",
    { timeout: 180_000 },
    async () => {
        // given a real codex agent and a real worktree
        const { loopy } = tempLoopy()
        const repo = await tempGitRepo()
        const repository = new GitRepository(repo.path)
        const agent = new CodexAgent({ model: "gpt-5.4-mini" })
        let worktree!: Worktree

        // when it creates a two-line file and reports an array-root discriminated union
        const result = await testRun(loopy, async () => {
            worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", {
                prompt: `Create hello.txt with exactly these two lines:
hello
loopy

Report exactly two array entries in order: a file entry for hello.txt with lineCount 2, then a status entry with done true. Omit the optional note and warning fields.`,
                output: liveOutputSchema,
                worktree
            })
        })

        // then it returns the exact complex output and writes the requested file
        expect(result).toEqual([
            { kind: "file", path: "hello.txt", lineCount: 2 },
            { kind: "status", done: true }
        ])
        expect(fs.readFileSync(path.join(worktree.path, "hello.txt"), "utf8")).toBe("hello\nloopy\n")
        // and the session succeeds with a valid worktree snapshot
        const run = await loopy.runs.get((await loopy.runs.list())[0].id)
        const step = run.steps.find((candidate) => candidate.kind === "agent")!
        if (step.kind !== "agent") throw new Error("unreachable")
        const session = await loopy.sessions.get(step.sessionId!)
        expect(session.status).toBe("succeeded")
        expect(session.messages.length).toBeGreaterThan(2)
        expect((await worktree.git(["rev-parse", step.snapshotRef!])).exitCode).toBe(0)
    }
)
