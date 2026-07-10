import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { CodexAgent } from "@loopy/codex/ai/codex-agent"
import { GitRepository, Worktree } from "@loopy/core/git"
import { uniqueName } from "@loopy/core/util"
import { runGit, tempGitRepo, tempLoopy, testRun } from "@loopy/test-utils"
import { fakeCodex } from "./fake-codex-sdk"

const outputSchema = z.object({ done: z.boolean() })

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
    const step = run.steps[0]
    expect(step.kind).toBe("agent")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect(step.snapshotRef).toBe(
        `refs/loopy/agent/${uniqueName("test-workflow/test-key")}/1/${uniqueName("implement")}`
    )
    expect((await worktree.git(["rev-parse", step.snapshotRef!])).exitCode).toBe(0)
    // and the session records provider metadata and the normalized conversation
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.provider).toBe("codex")
    expect(session.model).toBe("gpt-5.4")
    expect(session.status).toBe("succeeded")
    expect(session.messages.map((message) => message.role)).toEqual([
        "user",
        "system",
        "assistant",
        "tool",
        "tool_result",
        "assistant"
    ])
    expect(session.messages[0].content).toBe("do it")
    expect(JSON.parse(session.messages[1].content)).toEqual({
        threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        model: "gpt-5.4"
    })
    expect(session.messages[2].content).toBe("I should add the requested file.")
    expect(JSON.parse(session.messages[3].content)).toEqual({
        id: "change_1",
        tool: "file_change",
        input: { changes: [{ path: "src/hello.ts", kind: "add" }] }
    })
    expect(session.messages.at(-1)!.content).toBe(JSON.stringify({ done: true }))
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
                    result: {
                        content: [{ type: "text", text: "found" }],
                        structured_content: { found: true }
                    },
                    status: "completed"
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
    const step = run.steps[0]
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.messages.map((message) => message.role)).toEqual([
        "user",
        "system",
        "assistant",
        "tool",
        "tool_result",
        "tool",
        "tool_result",
        "tool",
        "tool_result",
        "tool",
        "tool_result",
        "assistant",
        "tool_result",
        "assistant"
    ])
    // and tool starts carry stable ids, names and inputs
    expect(JSON.parse(session.messages[3].content)).toEqual({
        id: "command_1",
        tool: "command_execution",
        input: { command: "pnpm test" }
    })
    expect(JSON.parse(session.messages[7].content)).toEqual({
        id: "mcp_1",
        tool: "docs.lookup",
        input: { key: "value" }
    })
    expect(JSON.parse(session.messages[9].content)).toEqual({
        id: "search_1",
        tool: "web_search",
        input: { query: "loopy" }
    })
    // and tool completions preserve the authoritative completed item
    expect(JSON.parse(session.messages[4].content)).toEqual({
        toolUseId: "command_1",
        content: {
            id: "command_1",
            type: "command_execution",
            command: "pnpm test",
            aggregated_output: "passed",
            exit_code: 0,
            status: "completed"
        }
    })
    expect(JSON.parse(session.messages[11].content)).toEqual({
        todoList: [{ text: "Inspect", completed: true }]
    })
    expect(JSON.parse(session.messages[12].content)).toEqual({
        toolUseId: "error_1",
        content: { id: "error_1", type: "error", message: "optional tool unavailable" }
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
    // and the thread is locked to the worktree without approvals
    expect(threadOptions).toEqual([
        {
            model: "gpt-5.4",
            workingDirectory: worktree.path,
            sandboxMode: "workspace-write",
            approvalPolicy: "never"
        }
    ])
    // and the rendered prompt and JSON schema are passed to the streamed turn
    expect(runCalls).toHaveLength(1)
    expect(runCalls[0].input).toBe("do it")
    expect(runCalls[0].options).toEqual({
        outputSchema: {
            type: "object",
            properties: { done: { type: "boolean" } },
            required: ["done"],
            additionalProperties: false
        }
    })
})

test("CodexAgent forwards every configured native SDK option", async () => {
    // given a codex agent configured with every supported client and thread option
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory, clientOptions, threadOptions } = fakeCodex(() => ({ output: { done: true } }))
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

test("CodexAgent retains format annotations and recursive references in the output schema", async () => {
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
    // and only the schema metadata is removed while provider-supported keywords remain
    const schema = runCalls[0].options!.outputSchema as {
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
    ).rejects.toThrow("Date cannot be represented in JSON Schema")

    // then the SDK thread and turn are never started
    expect(threadOptions).toHaveLength(0)
    expect(runCalls).toHaveLength(0)
    // and the durable step and session are failed
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
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
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.status).toBe("failed")
    expect(session.messages.map((message) => message.role)).toEqual(["user", "system", "assistant"])
})

test("a fatal Codex stream event fails the durable step", async () => {
    // given a fake SDK that emits a fatal stream error
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({ streamError: "connection lost" }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the fatal event is surfaced as a provider error
    await expect(result).rejects.toThrow("Codex agent stream error: connection lost")
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
    const step = run.steps[0]
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.status).toBe("failed")
    expect(session.messages.map((message) => message.role)).toEqual(["user", "system"])
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

test("a completed turn without a final response fails the step", async () => {
    // given a fake SDK that completes without an agent message
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({}))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the missing response is rejected
    await expect(result).rejects.toThrow("Codex agent returned no final response")
})

test("a non-JSON final response fails the step", async () => {
    // given a fake SDK returning plain text despite the structured output request
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { codexFactory } = fakeCodex(() => ({ outputText: "all done" }))
    const agent = new CodexAgent({ model: "gpt-5.4", codexFactory })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then invalid structured output is rejected
    await expect(result).rejects.toThrow("Codex agent returned invalid structured output")
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
    const step = run.steps[0]
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

    // when the workflow fails after the agent and its changes are discarded
    await expect(testRun(loopy, body)).rejects.toThrow("boom")
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])
    // and the workflow resumes from the later step
    publishImpl = () => "published"
    expect(await testRun(loopy, body, { from: "publish" })).toBe("published")

    // then the SDK ran once and the stored snapshot restored the change
    expect(runCalls).toHaveLength(1)
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
})

test.skipIf(!process.env.CODEX_AGENT_LIVE_TEST)(
    "live: CodexAgent performs a real coding task",
    { timeout: 180_000 },
    async () => {
        // given a real codex agent and a real worktree
        const { loopy } = tempLoopy()
        const repo = await tempGitRepo()
        const repository = new GitRepository(repo.path)
        const agent = new CodexAgent({ model: "gpt-5.4" })
        let worktree!: Worktree

        // when it performs a tiny coding task
        const result = await testRun(loopy, async () => {
            worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", {
                prompt: "Create a file named hello.txt containing exactly: hi",
                output: outputSchema,
                worktree
            })
        })

        // then it reports completion and the file exists in the worktree
        expect(result.done).toBe(true)
        expect(fs.readFileSync(path.join(worktree.path, "hello.txt"), "utf8")).toContain("hi")
        // and the session records a succeeded conversation
        const run = await loopy.runs.get((await loopy.runs.list())[0].id)
        const step = run.steps[0]
        if (step.kind !== "agent") throw new Error("unreachable")
        const session = await loopy.sessions.get(step.sessionId!)
        expect(session.status).toBe("succeeded")
        expect(session.messages.length).toBeGreaterThan(2)
    }
)
