import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { ClaudeAgent } from "@loopy/claude/ai/claude-agent"
import { GitRepository, Worktree } from "@loopy/core/git"
import { uniqueName } from "@loopy/core/util"
import { fakeClaudeQuery } from "./fake-claude-sdk"
import { runGit, tempGitRepo, tempLoopy, testRun } from "@loopy/test-utils"

const outputSchema = z.object({ done: z.boolean() })

test("ClaudeAgent maps the SDK conversation to the session and snapshots the worktree", async () => {
    // given a fake SDK scripted with text, a file-writing tool call and a structured output
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query } = fakeClaudeQuery(() => ({
        text: ["Writing the file now."],
        toolCalls: [
            {
                name: "Write",
                id: "toolu_write1",
                input: { file_path: "src/hello.ts" },
                change: { file: "src/hello.ts", text: "export const hi = 1\n" },
                result: "File created successfully"
            }
        ],
        output: { done: true }
    }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })
    let worktree!: Worktree

    // when the agent runs inside a durable step
    const result = await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then it returns the structured output
    expect(result).toEqual({ done: true })
    // and the tool call's file change is applied to the worktree
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
    // and the run records an agent step with a snapshot ref
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.kind).toBe("agent")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect(step.snapshotRef).toBe(
        `refs/loopy/agent/${uniqueName("test-workflow/test-key")}/1/${uniqueName("implement")}`
    )
    expect((await worktree.git(["rev-parse", step.snapshotRef!])).exitCode).toBe(0)
    // and the session is persisted with provider and model info and succeeds
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.kind).toBe("coding-agent")
    expect(session.provider).toBe("claude")
    expect(session.model).toBe("claude-sonnet-5")
    expect(session.status).toBe("succeeded")
    // and the conversation is mapped onto session messages, distinguishing the tool call from its result
    expect(session.messages.map((m) => m.role)).toEqual([
        "user",
        "system",
        "assistant",
        "tool",
        "tool_result",
        "assistant"
    ])
    expect(session.messages[0].content).toBe("do it")
    expect(session.messages[2].content).toBe("Writing the file now.")
    expect(session.messages[3].content).toBe(
        JSON.stringify({ id: "toolu_write1", tool: "Write", input: { file_path: "src/hello.ts" } })
    )
    expect(session.messages[4].content).toBe(
        JSON.stringify({ toolUseId: "toolu_write1", content: "File created successfully" })
    )
    // and the system message records the SDK session id
    expect(JSON.parse(session.messages[1].content).sessionId).toMatch(/^[0-9a-f-]{36}$/)
    // and the final assistant message carries the structured output
    expect(session.messages.at(-1)!.content).toBe(JSON.stringify({ done: true }))
})

test("ClaudeAgent records every supported SDK message and block type", async () => {
    // given a fake SDK scripted with one of each block type the recorder supports
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query } = fakeClaudeQuery(() => ({
        thinking: ["Let me look around."],
        text: ["Here is my plan."],
        toolCalls: [
            { name: "Read", kind: "tool_use", id: "toolu_read1", input: { file_path: "a.ts" }, result: "contents" },
            {
                name: "web_search",
                kind: "server_tool_use",
                id: "toolu_srv1",
                input: { query: "loopy" },
                result: "hits"
            },
            { name: "lookup", kind: "mcp_tool_use", id: "toolu_mcp1", input: { key: "v" }, result: "value" }
        ],
        output: { done: true }
    }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })

    // when the agent runs
    await testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the prompt, init, thinking, text, every tool call, every result and the output are all recorded
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.messages.map((m) => m.role)).toEqual([
        "user", // prompt
        "system", // init
        "assistant", // thinking
        "assistant", // text
        "tool", // tool_use
        "tool_result",
        "tool", // server_tool_use
        "tool_result",
        "tool", // mcp_tool_use
        "tool_result",
        "assistant" // structured output
    ])
    // and the assistant thinking and text are preserved verbatim
    expect(session.messages[2].content).toBe("Let me look around.")
    expect(session.messages[3].content).toBe("Here is my plan.")
    // and each tool call records its name, input and correlation id regardless of the tool kind
    expect(JSON.parse(session.messages[4].content)).toEqual({
        id: "toolu_read1",
        tool: "Read",
        input: { file_path: "a.ts" }
    })
    expect(JSON.parse(session.messages[6].content)).toEqual({
        id: "toolu_srv1",
        tool: "web_search",
        input: { query: "loopy" }
    })
    expect(JSON.parse(session.messages[8].content)).toEqual({ id: "toolu_mcp1", tool: "lookup", input: { key: "v" } })
    // and each result is paired to its call by the shared tool_use_id
    expect(JSON.parse(session.messages[5].content)).toEqual({ toolUseId: "toolu_read1", content: "contents" })
    expect(JSON.parse(session.messages[7].content)).toEqual({ toolUseId: "toolu_srv1", content: "hits" })
    expect(JSON.parse(session.messages[9].content)).toEqual({ toolUseId: "toolu_mcp1", content: "value" })
})

test("ClaudeAgent passes default options to the SDK", async () => {
    // given a claude agent configured with only a model
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query, calls } = fakeClaudeQuery(() => ({ output: { done: true } }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })
    let worktree!: Worktree

    // when the agent runs
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the SDK receives the rendered prompt exactly once
    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toBe("do it")
    // and the worktree path as its working directory
    const options = calls[0].options!
    expect(options.cwd).toBe(worktree.path)
    // and the auto command classifier as permission mode
    expect(options.permissionMode).toBe("auto")
    // and the AskUserQuestion tool disabled
    expect(options.disallowedTools).toEqual(["AskUserQuestion"])
    // and the claude code preset system prompt
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" })
    // and project-only setting sources
    expect(options.settingSources).toEqual(["project"])
    // and the configured model
    expect(options.model).toBe("claude-sonnet-5")
    // and the output schema as structured output format, without the $schema marker the API silently rejects
    expect(options.outputFormat).toEqual({
        type: "json_schema",
        schema: {
            type: "object",
            properties: { done: { type: "boolean" } },
            required: ["done"],
            additionalProperties: false
        }
    })
    // and no options that were not configured
    expect(options.maxTurns).toBeUndefined()
    expect(options.env).toBeUndefined()
    expect(options.allowedTools).toBeUndefined()
})

test("ClaudeAgent passes configured options to the SDK", async () => {
    // given a claude agent with every option customized
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query, calls } = fakeClaudeQuery(() => ({ output: { done: true } }))
    const agent = new ClaudeAgent({
        model: "claude-opus-4-8",
        maxTurns: 5,
        env: { CLAUDE_TEST: "1" },
        allowedTools: ["Read", "Write"],
        disallowedTools: ["WebSearch"],
        settingSources: [],
        systemPrompt: "custom prompt",
        query
    })

    // when the agent runs
    await testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the SDK receives the configured options
    const options = calls[0].options!
    expect(options.model).toBe("claude-opus-4-8")
    expect(options.maxTurns).toBe(5)
    // and the configured env is merged onto the process environment rather than replacing it
    expect(options.env!.CLAUDE_TEST).toBe("1")
    expect(options.env!.PATH).toBe(process.env.PATH)
    expect(options.allowedTools).toEqual(["Read", "Write"])
    // and the AskUserQuestion guard is merged in alongside the caller's disallowed tools
    expect(options.disallowedTools).toEqual(["WebSearch", "AskUserQuestion"])
    expect(options.settingSources).toEqual([])
    expect(options.systemPrompt).toBe("custom prompt")
    // and the session records the configured model
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).model).toBe("claude-opus-4-8")
})

test("format keywords are stripped from the wire schema and folded into descriptions", async () => {
    // given an output schema whose fields emit JSON schema format keywords the CLI silently rejects
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const output = { deployedAt: "2026-07-08T09:30:00Z", contact: "bob@example.com" }
    const { query, calls } = fakeClaudeQuery(() => ({ output }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })
    const formatSchema = z.object({
        deployedAt: z.iso.datetime().describe("when it was deployed"),
        contact: z.email()
    })

    // when the agent runs
    const result = await testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: formatSchema, worktree })
    })

    // then the run succeeds, proving the fake saw no format keywords it would drop structured output for
    expect(result).toEqual(output)
    // and the wire schema carries the formats folded into descriptions instead
    const schema = calls[0].options!.outputFormat!.schema as {
        properties: Record<string, Record<string, unknown>>
    }
    expect(schema.properties.deployedAt.description).toBe("when it was deployed (format: date-time)")
    expect(schema.properties.contact.description).toBe("format: email")
    // and the validation patterns are preserved
    expect(schema.properties.deployedAt.pattern).toBeDefined()
})

test("a non-JSON-representable output schema fails the step without invoking the SDK", async () => {
    // given an output schema containing a Date, which JSON structured output cannot represent
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query, calls } = fakeClaudeQuery(() => ({ output: { done: true } }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })

    // when the agent runs
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

    // then the SDK is never invoked
    expect(calls).toHaveLength(0)
    // and the agent step and the session are marked failed
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
})

test("a recursive output schema fails the step without invoking the SDK", async () => {
    // given a self-referential output schema, which structured outputs reject as recursive
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query, calls } = fakeClaudeQuery(() => ({ output: { name: "root", children: [] } }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })
    const category: z.ZodType = z.lazy(() => z.object({ name: z.string(), children: z.array(category) }))

    // when the agent runs against the recursive schema
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: category, worktree })
        })
    ).rejects.toThrow("Claude agent output schema is recursive")

    // then the SDK is never invoked
    expect(calls).toHaveLength(0)
    // and the agent step and the session are marked failed
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
})

test("an error result fails the step and the session", async () => {
    // given a fake SDK that ends with a max-turns error result
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query } = fakeClaudeQuery(() => ({
        text: ["Still trying..."],
        errorSubtype: "error_max_turns",
        errors: ["exceeded maximum turns"]
    }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })

    // when the agent runs
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    ).rejects.toThrow("Claude agent failed with error_max_turns: exceeded maximum turns")

    // then the agent step is marked failed
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    // and the session is marked failed with the messages recorded so far preserved
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.status).toBe("failed")
    expect(session.messages.map((m) => m.role)).toEqual(["user", "system", "assistant"])
})

test("a success result without structured output fails the step", async () => {
    // given a fake SDK whose success result carries no structured output
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query } = fakeClaudeQuery(() => ({ text: ["All done."] }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })

    // when the agent runs
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    ).rejects.toThrow("Claude agent returned no structured output")

    // then the agent step and the session are marked failed
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
})

test("structured output violating the schema fails the step", async () => {
    // given a fake SDK returning structured output that does not match the schema
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query } = fakeClaudeQuery(() => ({ output: { done: "yes" } }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })

    // when the agent runs
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    ).rejects.toThrow()

    // then the agent step and the session are marked failed
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
})

test("a mid-stream SDK failure fails the step and preserves recorded messages", async () => {
    // given a fake SDK that throws right after the init message
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query } = fakeClaudeQuery(() => ({ throwMidStream: new Error("process exited unexpectedly") }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })

    // when the agent runs
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    ).rejects.toThrow("process exited unexpectedly")

    // then the agent step and the session are marked failed
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.status).toBe("failed")
    // and the messages recorded before the failure are preserved
    expect(session.messages.map((m) => m.role)).toEqual(["user", "system"])
})

test("a stream that ends without a result fails the step", async () => {
    // given a fake SDK whose stream ends without a result message
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query } = fakeClaudeQuery(() => ({ text: ["hm"], endWithoutResult: true }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })

    // when the agent runs
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    ).rejects.toThrow("Claude agent stream ended without a result")

    // then the agent step is marked failed
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    expect(run.steps[0].status).toBe("failed")
})

test("claude agent step replay restores the worktree without re-invoking the SDK", async () => {
    // given a claude agent backed by a fake SDK and a publish step that initially fails
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { query, calls } = fakeClaudeQuery(() => ({
        toolCalls: [
            {
                name: "Write",
                input: { file_path: "src/hello.ts" },
                change: { file: "src/hello.ts", text: "export const hi = 1\n" }
            }
        ],
        output: { done: true }
    }))
    const agent = new ClaudeAgent({ model: "claude-sonnet-5", query })
    let publishImpl: () => string = () => {
        throw new Error("boom")
    }
    let worktree!: Worktree
    const body = async () => {
        worktree = await repository.worktree({ base: "main" })
        await agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        return loopy.step("publish", z.string(), async () => publishImpl())
    }

    // when the workflow runs and the publish step throws
    await expect(testRun(loopy, body)).rejects.toThrow("boom")
    // and the worktree's uncommitted changes are discarded
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])
    // and the workflow resumes from the publish step with a working implementation
    publishImpl = () => "published"
    expect(await testRun(loopy, body, { from: "publish" })).toBe("published")

    // then the SDK is invoked exactly once
    expect(calls).toHaveLength(1)
    // and the worktree snapshot from the earlier agent step is restored
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
})

test.skipIf(!process.env.CLAUDE_AGENT_LIVE_TEST)(
    "live: ClaudeAgent performs a real coding task",
    { timeout: 180_000 },
    async () => {
        // given a real claude agent and a real worktree
        const { loopy } = tempLoopy()
        const repo = await tempGitRepo()
        const repository = new GitRepository(repo.path)
        const agent = new ClaudeAgent({ model: "claude-sonnet-5" })
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

test.skipIf(!process.env.CLAUDE_AGENT_LIVE_TEST)(
    "live: ClaudeAgent extracts file contents into a format-annotated schema",
    { timeout: 180_000 },
    async () => {
        // given a real claude agent and a worktree holding a file with deployment details
        const { loopy } = tempLoopy()
        const repo = await tempGitRepo()
        const repository = new GitRepository(repo.path)
        const agent = new ClaudeAgent({ model: "claude-sonnet-5" })

        // when the agent reads the file and reports it against a schema with format-emitting fields
        const result = await testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            fs.writeFileSync(
                path.join(worktree.path, "info.txt"),
                "Deployed at: 2026-07-08T09:30:00Z\nContact: bob@example.com\n"
            )
            return agent.run("report", {
                prompt: "Read info.txt and report the deployment time and the contact email.",
                output: z.object({ deployedAt: z.iso.datetime(), contact: z.email() }),
                worktree
            })
        })

        // then the extracted values satisfy the format-annotated schema
        expect(new Date(result.deployedAt).toISOString()).toBe("2026-07-08T09:30:00.000Z")
        expect(result.contact).toBe("bob@example.com")
        // and the session records a succeeded conversation
        const run = await loopy.runs.get((await loopy.runs.list())[0].id)
        const step = run.steps[0]
        if (step.kind !== "agent") throw new Error("unreachable")
        expect((await loopy.sessions.get(step.sessionId!)).status).toBe("succeeded")
    }
)
