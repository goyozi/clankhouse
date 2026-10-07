import { FakeCodingAgent, FakeLLM, runOutput, tempClankHouse, tempGitRepo } from "@clankhouse/testing"
import { testSession } from "@clankhouse/test-utils"
import { GitRepository } from "@clankhouse/core/git"
import { ExecutionStatus, StepKind, ToolResultStatus, ToolSourceKind } from "@clankhouse/protocol"
import { expect, test } from "vitest"
import * as z from "zod"
import { nextRunningStep, rpcClient, testServer } from "./helpers"

function json(value: unknown): string {
    return JSON.stringify(value)
}

function native(value: string | undefined): unknown {
    return value === undefined ? undefined : JSON.parse(value)
}

test("serves a FakeLLM and FakeCodingAgent workflow through the complete RPC surface", async () => {
    // given a real ClankHouse instance, Git repository, fake model, fake coding agent and registered workflow
    const { clankhouse } = tempClankHouse()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let llmCalls = 0
    let agentCalls = 0
    let published = "v1"
    const llm = new FakeLLM((_stepName, prompt) => {
        llmCalls++
        return { summary: `summary:${prompt}` }
    })
    const agent = new FakeCodingAgent(() => {
        agentCalls++
        return {
            changes: [{ file: "result.txt", text: "implemented\n" }],
            output: { done: true }
        }
    })
    clankhouse.registerWorkflow(
        "build",
        {
            input: z.object({ id: z.string(), topic: z.string() }),
            output: z.object({
                summary: z.string(),
                approved: z.boolean(),
                artifactId: z.string(),
                published: z.string()
            }),
            key: (input) => input.id
        },
        async (input) => {
            const plan = await llm.call("plan", {
                prompt: input.topic,
                output: z.object({ summary: z.string() })
            })
            const worktree = await repository.worktree({ base: "main" })
            await agent.run("implement", {
                prompt: plan.summary,
                output: z.object({ done: z.boolean() }),
                worktree
            })
            const artifact = await clankhouse.artifacts.writeText("summary", plan.summary, "text/plain")
            const approval = await clankhouse.waitFor({
                key: `approval:${input.id}`,
                schema: z.object({ ok: z.boolean() })
            })
            const result = await clankhouse.step("publish", z.string(), async () => published)
            return { summary: plan.summary, approved: approval.ok, artifactId: artifact.id, published: result }
        }
    )
    const server = await testServer(clankhouse)
    const client = rpcClient(server)

    // when discovering and starting the workflow through a real Connect client
    expect(await client.listWorkflows({})).toMatchObject({ workflows: [{ name: "build" }] })
    const definition = (await client.getWorkflow({ name: "build" })).workflow!
    expect(native(definition.inputSchemaJson)).toMatchObject({ type: "object" })
    expect(native(definition.outputSchemaJson)).toMatchObject({ type: "object" })
    expect(native(definition.inputSchemaJson)).not.toHaveProperty("$schema")
    expect(native(definition.outputSchemaJson)).not.toHaveProperty("$schema")
    const started = await client.startRun({
        workflowName: "build",
        inputJson: json({ id: "feature-1", topic: "rpc" })
    })
    const stream = client.watchRun({ runId: started.runId })[Symbol.asyncIterator]()
    await nextRunningStep(stream, "wait:approval:feature-1")
    await client.emitEvent({ key: "approval:feature-1", inputJson: json({ ok: true }) })
    const remaining = []
    while (true) {
        const item = await stream.next()
        if (item.done) break
        remaining.push(item.value)
    }

    // then the run completes with typed steps, sessions, output and filterable metadata
    expect(remaining.at(-1)?.item).toMatchObject({
        case: "run",
        value: { id: started.runId, status: ExecutionStatus.SUCCEEDED }
    })
    const fetched = (await client.getRun({ runId: started.runId })).run!
    expect(fetched.metadata).toMatchObject({ workflowName: "build", key: "feature-1", attempt: 1 })
    expect(fetched.steps.map((step) => step.kind)).toEqual([
        StepKind.LLM,
        StepKind.WORKTREE,
        StepKind.AGENT,
        StepKind.ARTIFACT,
        StepKind.EVENT,
        StepKind.CUSTOM
    ])
    expect(native(fetched.outputJson)).toMatchObject({ approved: true, published: "v1", summary: "summary:rpc" })
    const storedRun = clankhouse.db.prepare("SELECT output FROM runs WHERE id = ?").get(started.runId) as {
        output: string
    }
    expect(fetched.outputJson).toBe(storedRun.output)
    const storedSteps = new Map(
        (
            clankhouse.db
                .prepare("SELECT id, output FROM steps WHERE run_id = ? ORDER BY seq")
                .all(started.runId) as Array<{
                id: string
                output: string
            }>
        ).map((step) => [step.id, step.output])
    )
    expect(fetched.steps.map((step) => step.outputJson)).toEqual(fetched.steps.map((step) => storedSteps.get(step.id)))
    expect(
        await client.listRuns({ workflowName: "build", statuses: [ExecutionStatus.SUCCEEDED], limit: 1 })
    ).toMatchObject({ runs: [{ id: started.runId }] })

    // and artifact and session content are available through their dedicated RPCs
    const artifactId = fetched.artifacts[0]!.id
    expect((await client.getArtifact({ artifactId })).artifact).toMatchObject({
        id: artifactId,
        name: "summary",
        mimeType: "text/plain"
    })
    const chunks = await Array.fromAsync(client.readArtifact({ artifactId }))
    expect(Buffer.concat(chunks.map((chunk) => chunk.chunk)).toString()).toBe("summary:rpc")
    const sessionId = fetched.steps.find((step) => step.kind === StepKind.LLM)!.sessionId!
    const session = (await client.getSession({ sessionId })).session!
    expect(session).toMatchObject({ client: "fake-llm", provider: "fake", status: ExecutionStatus.SUCCEEDED })
    expect((await Array.fromAsync(client.watchSession({ sessionId }))).map((response) => response.message!.id)).toEqual(
        session.messages.map((message) => message.id)
    )

    // when rerunning only the publish step
    published = "v2"
    const rerun = await client.rerunRun({ runId: started.runId, fromStepKey: "publish" })
    await Array.fromAsync(client.watchRun({ runId: rerun.runId }))

    // then earlier fake providers are replayed and only publish changes
    const rerunResult = (await client.getRun({ runId: rerun.runId })).run!
    expect(rerunResult.metadata?.attempt).toBe(2)
    expect(native(rerunResult.outputJson)).toMatchObject({ published: "v2" })
    expect({ llmCalls, agentCalls }).toEqual({ llmCalls: 1, agentCalls: 1 })
})

test("serves structured session messages, tool calls and tool results", async () => {
    // given a completed session containing every session message variant
    const { clankhouse } = tempClankHouse()
    const recorder = await testSession(clankhouse, {
        kind: "coding-agent",
        client: "fake-agent",
        provider: "fake",
        model: "fake"
    })
    recorder.addMessage("assistant", "checking")
    recorder.addToolCall({
        id: "read-1",
        name: "Read",
        source: { kind: "native" },
        input: { file_path: "src/a.ts" },
        common: { name: "file.read", path: "src/a.ts" }
    })
    recorder.addToolResult({ toolCallId: "read-1", status: "succeeded", output: "contents" })
    recorder.addToolCall({
        id: "change-1",
        name: "Edit",
        source: { kind: "native" },
        input: { file_path: "src/a.ts" },
        common: { name: "file.change", paths: ["src/a.ts", "src/b.ts"] }
    })
    recorder.addToolCall({
        id: "shell-1",
        name: "Bash",
        source: { kind: "native" },
        input: { command: "pnpm test", timeout: 1000 },
        common: { name: "shell.execute", command: "pnpm test" }
    })
    recorder.addToolCall({
        id: "file-search-1",
        name: "Grep",
        source: { kind: "native" },
        input: { pattern: "needle", path: "src", glob: "*.ts" },
        common: { name: "file.search", pattern: "needle", path: "src" }
    })
    recorder.addToolCall({
        id: "web-search-1",
        name: "WebSearch",
        source: { kind: "provider" },
        input: { query: "clankhouse", allowed_domains: ["example.com"] },
        common: { name: "web.search", query: "clankhouse" }
    })
    recorder.addToolCall({
        id: "mcp-1",
        name: "lookup",
        source: { kind: "mcp", server: "docs" },
        input: { query: "sessions" }
    })
    recorder.addToolResult({ toolCallId: "mcp-1", status: "failed", error: "unavailable" })
    recorder.succeed()
    const server = await testServer(clankhouse)
    const client = rpcClient(server)

    // when the session is fetched and watched through Connect
    const session = (await client.getSession({ sessionId: recorder.id })).session!
    const watched = await Array.fromAsync(client.watchSession({ sessionId: recorder.id }))

    // then the ordered oneof payloads retain normalized and provider-specific data
    expect(session.messages.map((message) => message.payload.case)).toEqual([
        "message",
        "toolCall",
        "toolResult",
        "toolCall",
        "toolCall",
        "toolCall",
        "toolCall",
        "toolCall",
        "toolResult"
    ])
    expect(session.messages[1]?.payload).toMatchObject({
        case: "toolCall",
        value: {
            id: "read-1",
            name: "Read",
            source: { kind: ToolSourceKind.NATIVE },
            inputJson: JSON.stringify({ file_path: "src/a.ts" }),
            common: { case: "fileRead", value: { path: "src/a.ts" } }
        }
    })
    expect(session.messages[2]?.payload).toMatchObject({
        case: "toolResult",
        value: {
            toolCallId: "read-1",
            status: ToolResultStatus.SUCCEEDED,
            outputJson: JSON.stringify("contents")
        }
    })
    expect(session.messages[3]?.payload).toMatchObject({
        case: "toolCall",
        value: { common: { case: "fileChange", value: { paths: ["src/a.ts", "src/b.ts"] } } }
    })
    expect(session.messages[4]?.payload).toMatchObject({
        case: "toolCall",
        value: { common: { case: "shellExecute", value: { command: "pnpm test" } } }
    })
    expect(session.messages[5]?.payload).toMatchObject({
        case: "toolCall",
        value: { common: { case: "fileSearch", value: { pattern: "needle", path: "src" } } }
    })
    expect(session.messages[6]?.payload).toMatchObject({
        case: "toolCall",
        value: { common: { case: "webSearch", value: { query: "clankhouse" } } }
    })
    expect(session.messages[7]?.payload).toMatchObject({
        case: "toolCall",
        value: { source: { kind: ToolSourceKind.MCP, server: "docs" }, common: { case: undefined } }
    })
    expect(session.messages[8]?.payload).toMatchObject({
        case: "toolResult",
        value: { status: ToolResultStatus.FAILED, error: "unavailable" }
    })
    // and watching yields the identical durable message sequence
    expect(watched.map((response) => response.message?.id)).toEqual(session.messages.map((message) => message.id))
})

test("distinguishes absent void schemas and values from present JSON null across protobuf", async () => {
    // given void and null workflows with matching input, output, and durable step schemas
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow("void-output", { input: z.void(), output: z.void(), key: () => "void" }, async () =>
        clankhouse.step("void-step", z.void(), async () => undefined)
    )
    clankhouse.registerWorkflow("null-output", { input: z.null(), output: z.null(), key: () => "null" }, async () =>
        clankhouse.step("null-step", z.null(), async () => null)
    )
    const server = await testServer(clankhouse)
    const client = rpcClient(server)

    // when their schemas and completed runs are read through protobuf
    const voidDefinition = (await client.getWorkflow({ name: "void-output" })).workflow!
    const nullDefinition = (await client.getWorkflow({ name: "null-output" })).workflow!
    const voidId = (await client.startRun({ workflowName: "void-output" })).runId
    const nullId = (await client.startRun({ workflowName: "null-output", inputJson: "null" })).runId
    await Promise.all([runOutput(clankhouse, voidId), runOutput(clankhouse, nullId)])
    const voidRun = (await client.getRun({ runId: voidId })).run!
    const nullRun = (await client.getRun({ runId: nullId })).run!

    // then void omits its input and output schemas and values while JSON null remains present as exact text
    expect(voidDefinition.inputSchemaJson).toBeUndefined()
    expect(voidDefinition.outputSchemaJson).toBeUndefined()
    expect(nullDefinition.inputSchemaJson).toBeDefined()
    expect(nullDefinition.outputSchemaJson).toBeDefined()
    expect(native(nullDefinition.inputSchemaJson)).not.toHaveProperty("$schema")
    expect(native(nullDefinition.outputSchemaJson)).not.toHaveProperty("$schema")
    expect(voidRun.outputJson).toBeUndefined()
    expect(voidRun.steps[0].outputJson).toBeUndefined()
    expect(nullRun.outputJson).toBe("null")
    expect(nullRun.steps[0].outputJson).toBe("null")
    // and protobuf output text exactly matches SQLite presence and contents
    expect(clankhouse.db.prepare("SELECT output FROM runs WHERE id = ?").get(voidId)).toEqual({ output: null })
    expect(clankhouse.db.prepare("SELECT output FROM runs WHERE id = ?").get(nullId)).toEqual({ output: "null" })
})
