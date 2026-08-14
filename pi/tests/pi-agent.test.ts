import * as fs from "node:fs"
import * as path from "node:path"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { PiAgent } from "@loopy/pi"
import { GitRepository, Worktree } from "@loopy/core/git"
import { uniqueName } from "@loopy/core/util"
import {
    instructedTags,
    runGit,
    runOutput,
    sessionTextMessages,
    sessionToolCallMessages,
    taggedOutput,
    tempDir,
    tempGitRepo,
    tempLoopy,
    testRun
} from "@loopy/test-utils"
import * as z from "zod"
import { expect, test } from "vitest"
import { fakePi, isolatedModelRuntime } from "./fake-pi-sdk"

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

test("PiAgent maps the SDK conversation to the session and snapshots the worktree", async () => {
    // given a fake Pi session scripted with reasoning, text, a file-writing tool call and structured output
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, sessions } = fakePi(() => ({
        thinking: ["I should add the requested file."],
        text: ["Writing the file now."],
        toolCalls: [
            {
                id: "tool_write_1",
                name: "write",
                arguments: { path: "src/hello.ts" },
                change: { file: "src/hello.ts", text: "export const hi = 1\n" },
                result: "File created"
            }
        ],
        output: { done: true }
    }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })
    let worktree!: Worktree

    // when the agent runs inside a durable step
    const result = await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then it returns structured output and applies the tool's file change
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
    // and the session records Pi metadata and every supported finalized message in order
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.client).toBe("pi")
    expect(session.provider).toBe("openai")
    expect(session.model).toBe("gpt-5.4")
    expect(session.status).toBe("succeeded")
    expect(session.messages.map((item) => (item.type === "message" ? item.role : item.type))).toEqual([
        "user",
        "system",
        "reasoning",
        "assistant",
        "tool_call",
        "tool_result",
        "assistant"
    ])
    const messages = sessionTextMessages(session.messages)
    expect(JSON.parse(messages[1].content)).toEqual({
        sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        provider: "openai",
        model: "gpt-5.4"
    })
    expect(messages[2].content).toBe("I should add the requested file.")
    expect(messages[3].content).toBe("Writing the file now.")
    expect(session.messages[4]).toMatchObject({
        toolCall: {
            id: "tool_write_1",
            name: "write",
            source: { kind: "native" },
            commonName: "file.change",
            input: { path: "src/hello.ts" },
            files: ["src/hello.ts"]
        }
    })
    expect(session.messages[5]).toMatchObject({
        toolResult: {
            toolCallId: "tool_write_1",
            status: "succeeded",
            output: {
                role: "toolResult",
                toolCallId: "tool_write_1",
                toolName: "write",
                content: [{ type: "text", text: "File created" }],
                isError: false
            }
        }
    })
    expect(messages.at(-1)!.content).toBe(taggedOutput(messages[0].content, JSON.stringify({ done: true })))
    // and the Pi subscription and in-memory session are cleaned up
    expect(sessions).toEqual([{ disposed: true, unsubscribed: true }])
})

test("PiAgent normalizes the built-in ls tool as file search", async () => {
    // given a Pi session with the optional built-in ls tool enabled
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const worktree = new Worktree(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession } = fakePi(() => ({
        toolCalls: [{ id: "tool_ls_1", name: "ls", arguments: { path: "src" }, result: "hello.ts" }],
        output: { done: true }
    }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime, tools: ["ls"] },
        createAgentSession
    })

    // when the agent lists a directory
    await testRun(loopy, () => agent.run("inspect", { prompt: "list files", output: outputSchema, worktree }))

    // then the call uses the shared file-search classification
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    const calls = sessionToolCallMessages((await loopy.sessions.get(step.sessionId!)).messages)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
        toolCall: {
            id: "tool_ls_1",
            name: "ls",
            source: { kind: "native" },
            commonName: "file.search",
            input: { path: "src" }
        }
    })
})

test("PiAgent records extension custom messages as user messages", async () => {
    // given a fake Pi extension message with display metadata and structured details
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const worktree = new Worktree(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession } = fakePi(() => ({
        customMessages: [
            {
                customType: "review-status",
                content: [{ type: "text", text: "Review completed." }],
                display: true,
                details: { findings: 2 }
            }
        ],
        finalResponse: "All done."
    }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs with the extension message in its conversation
    await testRun(loopy, () => agent.run("review", { prompt: "review", output: z.void(), worktree }), {
        output: z.void()
    })

    // then Loopy records the extension message as a user message without losing its metadata
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    const messages = sessionTextMessages(session.messages)
    expect(messages.map((item) => item.role)).toEqual(["user", "system", "user", "assistant"])
    expect(JSON.parse(messages[2].content)).toEqual({
        customType: "review-status",
        content: [{ type: "text", text: "Review completed." }],
        display: true,
        details: { findings: 2 }
    })
})

test("PiAgent runs a void-output step without instructed output framing", async () => {
    // given a fake Pi session that writes a file and returns ordinary text
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, prompts } = fakePi(() => ({
        toolCalls: [
            {
                name: "write",
                arguments: { path: "src/hello.ts" },
                change: { file: "src/hello.ts", text: "export const hi = 1\n" }
            }
        ],
        finalResponse: "All done."
    }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })
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

    // then it returns nothing and sends the bare prompt to Pi
    expect(result).toBeUndefined()
    expect(prompts).toEqual(["do it"])
    // and the coding change is applied and snapshotted
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await worktree.git(["rev-parse", step.snapshotRef!])).exitCode).toBe(0)
})

test("PiAgent preserves an unknown tool and normalizes its failed result", async () => {
    // given an unknown Pi extension tool that returns an error
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const worktree = new Worktree(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession } = fakePi(() => ({
        toolCalls: [
            {
                id: "tool_custom_1",
                name: "deploy_preview",
                arguments: { environment: "test" },
                result: "deployment unavailable",
                isError: true
            }
        ],
        output: { done: true }
    }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs successfully after handling the tool failure
    await testRun(loopy, () => agent.run("implement", { prompt: "do it", output: outputSchema, worktree }))

    // then the raw tool remains available without a guessed common classification
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.messages.find((item) => item.type === "tool_call")).toMatchObject({
        toolCall: {
            id: "tool_custom_1",
            name: "deploy_preview",
            source: { kind: "native" },
            input: { environment: "test" }
        }
    })
    expect(session.messages.find((item) => item.type === "tool_result")).toMatchObject({
        toolResult: {
            toolCallId: "tool_custom_1",
            status: "failed",
            error: "deployment unavailable"
        }
    })
})

test("PiAgent joins final text blocks with Pi's standard newline behavior", async () => {
    // given a fake Pi session returning multiple final text blocks
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const worktree = new Worktree(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession } = fakePi(() => ({ finalTextBlocks: ["first", "second", "third"] }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when it runs with a root string output
    const result = await testRun(loopy, () =>
        agent.run("report", { prompt: "report naturally", output: z.string(), worktree })
    )

    // then the exact blocks are joined with newlines and persisted as the durable output
    expect(result).toBe("first\nsecond\nthird")
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    expect(step.outputJson).toBe(JSON.stringify("first\nsecond\nthird"))
})

test("PiAgent passes native defaults while locking Loopy-owned session options", async () => {
    // given a Pi agent configured with only its model, runtime and fake session factory
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, calls, prompts, promptOptions } = fakePi(() => ({ output: { done: true } }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })
    let worktree!: Worktree

    // when the agent runs
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the rendered prompt uses Loopy's instructed output instead of Pi-native output handling
    expect(prompts[0]).toMatch(/^do it\n\nIMPORTANT — requested final report:/)
    expect(promptOptions).toEqual([{ source: "rpc" }])
    expect(calls).toHaveLength(1)
    // and Loopy locks the model, runtime, worktree and non-persistent session manager
    expect(calls[0].cwd).toBe(worktree.path)
    expect(calls[0].model).toMatchObject({ provider: "openai", id: "gpt-5.4" })
    expect(calls[0].modelRuntime).toBe(modelRuntime)
    expect(calls[0].sessionManager!.getCwd()).toBe(worktree.path)
    expect(calls[0].sessionManager!.getSessionFile()).toBeUndefined()
    // and Pi's native resource and tool defaults remain unset except for interactive questioning
    expect(calls[0].resourceLoader).toBeUndefined()
    expect(calls[0].settingsManager).toBeUndefined()
    expect(calls[0].noTools).toBeUndefined()
    expect(calls[0].tools).toBeUndefined()
    expect(calls[0].excludeTools).toEqual(["ask_question"])
})

test("PiAgent forwards raw session options and merges the interactive tool guard", async () => {
    // given raw Pi options including duplicate exclusions and caller-owned values Loopy must replace
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, calls } = fakePi(() => ({ output: { done: true } }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: {
            modelRuntime,
            thinkingLevel: "high",
            noTools: "builtin",
            tools: ["read", "grep"],
            excludeTools: ["write", "ask_question", "write"]
        },
        createAgentSession
    })
    let worktree!: Worktree

    // when the agent runs against a real worktree
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then native configuration is forwarded verbatim where Loopy does not own it
    expect(calls[0].thinkingLevel).toBe("high")
    expect(calls[0].noTools).toBe("builtin")
    expect(calls[0].tools).toEqual(["read", "grep"])
    // and exclusions are deduplicated with ask_question forced off after the allowlist
    expect(calls[0].excludeTools).toEqual(["write", "ask_question"])
    // and the worktree-bound in-memory session remains enforced
    expect(calls[0].cwd).toBe(worktree.path)
    expect(calls[0].sessionManager!.getSessionFile()).toBeUndefined()
})

test("PiAgent resolves custom models from a custom agentDir", async () => {
    // given a custom Pi agent directory containing a local model catalog
    const { loopy } = tempLoopy()
    const agentDir = tempDir("loopy-pi-agent-")
    fs.writeFileSync(
        path.join(agentDir, "models.json"),
        JSON.stringify({
            providers: {
                "loopy-test": {
                    baseUrl: "http://localhost:11434/v1",
                    api: "openai-completions",
                    apiKey: "test-key",
                    models: [{ id: "fixture-model" }]
                }
            }
        })
    )
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const { createAgentSession, calls } = fakePi(() => ({ output: { done: true } }))
    const agent = new PiAgent({
        provider: "loopy-test",
        model: "fixture-model",
        sessionOptions: { agentDir },
        createAgentSession
    })

    // when the agent runs without an explicitly supplied ModelRuntime
    const result = await testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the model is resolved from that directory and forwarded to the session factory
    expect(result).toEqual({ done: true })
    expect(calls[0].agentDir).toBe(agentDir)
    expect(calls[0].model).toMatchObject({ provider: "loopy-test", id: "fixture-model" })
    expect(calls[0].modelRuntime).toBeInstanceOf(ModelRuntime)
})

test("an unknown Pi model fails before creating an SDK session", async () => {
    // given a Pi agent configured with a model absent from its isolated catalog
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, calls } = fakePi(() => ({ output: { done: true } }))
    const agent = new PiAgent({
        provider: "missing-provider",
        model: "missing-model",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then model resolution fails clearly without invoking the SDK session factory
    await expect(result).rejects.toThrow('Pi model not found: provider "missing-provider", model "missing-model"')
    expect(calls).toHaveLength(0)
})

test.each(["error", "aborted", "length", "toolUse", "deferred", "pending"] as const)(
    "PiAgent rejects terminal %s stop reasons",
    async (stopReason) => {
        // given a fake Pi session ending with a non-success stop reason
        const { loopy, dir } = tempLoopy()
        const repo = await tempGitRepo()
        const repository = new GitRepository(repo.path)
        const modelRuntime = await isolatedModelRuntime(dir)
        const { createAgentSession } = fakePi(() => ({
            output: { done: true },
            stopReason,
            errorMessage: "not successful"
        }))
        const agent = new PiAgent({
            provider: "openai",
            model: "gpt-5.4",
            sessionOptions: { modelRuntime },
            createAgentSession
        })

        // when the agent runs
        const result = testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })

        // then the provider stop is surfaced before instructed-output parsing
        await expect(result).rejects.toThrow(`Pi agent stopped with ${stopReason}: not successful`)
    }
)

test("a prompt failure is preserved when Pi cleanup also fails", async () => {
    // given a fake Pi session that emits reasoning, fails, and throws from both cleanup operations
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, sessions } = fakePi(() => ({
        thinking: ["Still working."],
        throwMidRun: new Error("provider connection failed"),
        unsubscribeError: new Error("unsubscribe failed"),
        disposeError: new Error("dispose failed")
    }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the original provider failure wins over cleanup failures
    await expect(result).rejects.toThrow("provider connection failed")
    // and both cleanup operations still run and earlier session messages remain available
    expect(sessions).toEqual([{ disposed: true, unsubscribed: true }])
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    if (step.kind !== "agent") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(sessionTextMessages(session.messages).map((item) => item.role)).toEqual(["user", "system", "reasoning"])
})

test("a Pi cleanup failure fails an otherwise successful step", async () => {
    // given a fake Pi session whose prompt succeeds but disposal fails
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, sessions } = fakePi(() => ({
        output: { done: true },
        disposeError: new Error("dispose failed")
    }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then cleanup failure prevents the durable step from succeeding
    await expect(result).rejects.toThrow("dispose failed")
    // and both cleanup operations were attempted
    expect(sessions).toEqual([{ disposed: true, unsubscribed: true }])
})

test("Pi output fails when the session has no final assistant message", async () => {
    // given a fake Pi session that completes without a final assistant message
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, sessions } = fakePi(() => ({ noFinalAssistant: true }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs with structured output
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("report", { prompt: "report", output: outputSchema, worktree })
    })

    // then the missing tagged report fails after the Pi session is cleaned up
    await expect(result).rejects.toThrow("did not return the instructed output tags")
    expect(sessions).toEqual([{ disposed: true, unsubscribed: true }])
})

test("an untagged Pi response fails instructed-output collection", async () => {
    // given a fake Pi session returning plain JSON without Loopy's nonce tags
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession } = fakePi(() => ({ finalResponse: JSON.stringify({ done: true }) }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("report", { prompt: "report", output: outputSchema, worktree })
    })

    // then the untagged response is rejected
    await expect(result).rejects.toThrow("AI did not return the instructed output tags")
})

test("invalid JSON inside Pi's instructed tags fails the step", async () => {
    // given a fake Pi session returning non-JSON inside the requested tags
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession } = fakePi((prompt) => {
        const { opening, closing } = instructedTags(prompt)
        return { finalResponse: `${opening}\nall done\n${closing}` }
    })
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("report", { prompt: "report", output: outputSchema, worktree })
    })

    // then invalid JSON is rejected
    await expect(result).rejects.toThrow("returned invalid JSON between the instructed output tags")
})

test("Pi structured output violating the Zod schema fails the step and session", async () => {
    // given a fake Pi session returning valid tagged JSON with the wrong field type
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession } = fakePi(() => ({ output: { done: "yes" } }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("report", { prompt: "report", output: outputSchema, worktree })
    })

    // then final validation rejects the output and marks the persisted session failed
    await expect(result).rejects.toThrow()
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps.find((candidate) => candidate.kind === "agent")!
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
})

test("a non-JSON-representable output schema fails before creating a Pi session", async () => {
    // given a Pi agent and an output schema containing a Date
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, calls } = fakePi(() => ({ output: { done: true } }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })

    // when the agent runs with the unsupported schema
    const result = testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        return agent.run("report", { prompt: "report", output: z.object({ when: z.date() }), worktree })
    })

    // then core rejects the schema before invoking the Pi session factory
    await expect(result).rejects.toThrow(/Coding agent "report" output schema.*when z\.date\(\)/)
    expect(calls).toHaveLength(0)
})

test("Pi agent step replay restores the worktree without re-invoking the SDK", async () => {
    // given a Pi agent backed by a fake session and a later failing durable step
    const { loopy, dir } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const modelRuntime = await isolatedModelRuntime(dir)
    const { createAgentSession, prompts } = fakePi(() => ({
        toolCalls: [
            {
                name: "write",
                arguments: { path: "src/hello.ts" },
                change: { file: "src/hello.ts", text: "export const hi = 1\n" }
            }
        ],
        output: { done: true }
    }))
    const agent = new PiAgent({
        provider: "openai",
        model: "gpt-5.4",
        sessionOptions: { modelRuntime },
        createAgentSession
    })
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

    // when the workflow fails after the agent and its worktree changes are discarded
    const firstId = loopy.start("test-workflow", null)
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])
    // and the workflow reruns from the later step
    publishImpl = () => "published"
    const secondId = loopy.rerun(firstId, { from: "publish" })
    expect(await runOutput(loopy, secondId)).toBe("published")

    // then Pi was prompted once and Loopy restored the stored worktree snapshot
    expect(prompts).toHaveLength(1)
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
})

test("PiAgent public session options exclude Loopy-owned fields", async () => {
    // given the public raw session option type
    type SessionOptions = ConstructorParameters<typeof PiAgent>[0]["sessionOptions"]

    // when compile-time ownership is checked
    type HasCwd = "cwd" extends keyof NonNullable<SessionOptions> ? true : false
    type HasModel = "model" extends keyof NonNullable<SessionOptions> ? true : false
    type HasSessionManager = "sessionManager" extends keyof NonNullable<SessionOptions> ? true : false

    // then Loopy-owned fields are unavailable while Pi-native fields remain exposed
    expect(false satisfies HasCwd).toBe(false)
    expect(false satisfies HasModel).toBe(false)
    expect(false satisfies HasSessionManager).toBe(false)
    expect({ thinkingLevel: "high" } satisfies NonNullable<SessionOptions>).toEqual({ thinkingLevel: "high" })
})

test.skipIf(!process.env.PI_AGENT_LIVE_TEST)(
    "live: PiAgent performs a coding task with non-trivial output",
    { timeout: 180_000 },
    async () => {
        // given a real pi agent and a real worktree
        const { loopy } = tempLoopy()
        const repo = await tempGitRepo()
        const repository = new GitRepository(repo.path)
        const agent = new PiAgent({
            provider: "openrouter",
            model: "deepseek/deepseek-v4-flash-0731"
        })
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
