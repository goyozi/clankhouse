import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { RequestOptions } from "node:https"
import { fileURLToPath } from "node:url"
import { create } from "@bufbuild/protobuf"
import { Code, ConnectError, createClient, createHandlerContext, type Interceptor } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-node"
import { FakeCodingAgent } from "@loopy/core/ai/fake-agent"
import { FakeLLM } from "@loopy/core/ai/fake-llm"
import { GitRepository } from "@loopy/core/git"
import type { Loopy } from "@loopy/core/loopy"
import {
    ExecutionStatus,
    LoopyService,
    ReadArtifactRequestSchema,
    StepKind,
    ToolResultStatus,
    ToolSourceKind
} from "@loopy/server/proto"
import { runOutput, tempDir, tempGitRepo, tempLoopy, testRun } from "@loopy/test-utils"
import { expect, onTestFinished, test } from "vitest"
import * as z from "zod"
import { listen, serve, type LoopyServer } from "../src"
import { loopyService } from "../src/service"

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")

function bearer(apiKey: string): Interceptor {
    return (next) => async (request) => {
        request.header.set("authorization", `Bearer ${apiKey}`)
        return next(request)
    }
}

function rpcClient(server: LoopyServer, apiKey = server.apiKey, nodeOptions?: RequestOptions) {
    return createClient(
        LoopyService,
        createConnectTransport({
            httpVersion: "1.1",
            baseUrl: server.url,
            interceptors: apiKey.length === 0 ? [] : [bearer(apiKey)],
            ...(nodeOptions !== undefined ? { nodeOptions } : {})
        })
    )
}

async function testServer(loopy: Loopy): Promise<LoopyServer> {
    const server = await listen(loopy, { port: 0 })
    onTestFinished(() => server.close())
    return server
}

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
    let buffered = ""
    for await (const chunk of stream) {
        buffered += String(chunk)
        const newline = buffered.indexOf("\n")
        if (newline !== -1) return buffered.slice(0, newline)
    }
    throw new Error("Process ended before writing a line")
}

function json(value: unknown): string {
    return JSON.stringify(value)
}

function native(value: string | undefined): unknown {
    return value === undefined ? undefined : JSON.parse(value)
}

function registerApproval(instance: Loopy, value: z.ZodTypeAny): void {
    instance.registerWorkflow(
        "approval",
        { input: z.object({ id: z.string(), value }), output: z.number(), key: (input) => input.id },
        async (input) => {
            await instance.step("record", z.number(), async () => 1)
            return (await instance.waitFor({ key: `approve:${input.id}`, schema: z.object({ value: z.number() }) }))
                .value
        }
    )
}

async function reopenWithIncompatibleInput(
    reopen: () => Loopy
): Promise<{ loopy: Loopy; client: ReturnType<typeof rpcClient> }> {
    const second = reopen()
    registerApproval(second, z.string())
    const server = await listen(second, { port: 0 })
    onTestFinished(() => server.close())
    return { loopy: second, client: rpcClient(server) }
}

function incompatibleInputOutcome(outcome: unknown): string {
    expect(outcome).toBeInstanceOf(ConnectError)
    expect(outcome).toMatchObject({ code: Code.FailedPrecondition })
    return (outcome as ConnectError).rawMessage
}

async function nextRunningStep(
    iterator: AsyncIterator<{ item: { case: "step" | "run" | undefined; value?: unknown } }>,
    key: string
): Promise<void> {
    while (true) {
        const item = await iterator.next()
        if (item.done) throw new Error(`Run stream ended before ${key} started`)
        if (
            item.value.item.case === "step" &&
            typeof item.value.item.value === "object" &&
            item.value.item.value !== null &&
            "key" in item.value.item.value &&
            item.value.item.value.key === key &&
            "status" in item.value.item.value &&
            item.value.item.value.status === ExecutionStatus.RUNNING
        ) {
            return
        }
    }
}

test("serves a FakeLLM and FakeCodingAgent workflow through the complete RPC surface", async () => {
    // given a real Loopy instance, Git repository, fake model, fake coding agent and registered workflow
    const { loopy } = tempLoopy()
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
    loopy.registerWorkflow(
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
            const artifact = await loopy.artifacts.writeText("summary", plan.summary, "text/plain")
            const approval = await loopy.waitFor({
                key: `approval:${input.id}`,
                schema: z.object({ ok: z.boolean() })
            })
            const result = await loopy.step("publish", z.string(), async () => published)
            return { summary: plan.summary, approved: approval.ok, artifactId: artifact.id, published: result }
        }
    )
    const server = await testServer(loopy)
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
    const storedRun = loopy.db.prepare("SELECT output FROM runs WHERE id = ?").get(started.runId) as { output: string }
    expect(fetched.outputJson).toBe(storedRun.output)
    const storedSteps = new Map(
        (
            loopy.db.prepare("SELECT id, output FROM steps WHERE run_id = ? ORDER BY seq").all(started.runId) as Array<{
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
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({
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
        input: { query: "loopy", allowed_domains: ["example.com"] },
        common: { name: "web.search", query: "loopy" }
    })
    recorder.addToolCall({
        id: "mcp-1",
        name: "lookup",
        source: { kind: "mcp", server: "docs" },
        input: { query: "sessions" }
    })
    recorder.addToolResult({ toolCallId: "mcp-1", status: "failed", error: "unavailable" })
    recorder.succeed()
    const server = await testServer(loopy)
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
        value: { common: { case: "webSearch", value: { query: "loopy" } } }
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
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("void-output", { input: z.void(), output: z.void(), key: () => "void" }, async () =>
        loopy.step("void-step", z.void(), async () => undefined)
    )
    loopy.registerWorkflow("null-output", { input: z.null(), output: z.null(), key: () => "null" }, async () =>
        loopy.step("null-step", z.null(), async () => null)
    )
    const server = await testServer(loopy)
    const client = rpcClient(server)

    // when their schemas and completed runs are read through protobuf
    const voidDefinition = (await client.getWorkflow({ name: "void-output" })).workflow!
    const nullDefinition = (await client.getWorkflow({ name: "null-output" })).workflow!
    const voidId = (await client.startRun({ workflowName: "void-output" })).runId
    const nullId = (await client.startRun({ workflowName: "null-output", inputJson: "null" })).runId
    await Promise.all([runOutput(loopy, voidId), runOutput(loopy, nullId)])
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
    expect(loopy.db.prepare("SELECT output FROM runs WHERE id = ?").get(voidId)).toEqual({ output: null })
    expect(loopy.db.prepare("SELECT output FROM runs WHERE id = ?").get(nullId)).toEqual({ output: "null" })
})

test("persists a private credential and authenticates unary and streaming RPCs", async () => {
    // given a server using a fresh Loopy directory
    const { loopy } = tempLoopy()
    const server = await testServer(loopy)
    const credentials = JSON.parse(fs.readFileSync(server.credentialsFile, "utf8")) as {
        version: number
        apiKey: string
    }

    // then it reports its actual loopback address without enumerating its secret
    expect(server).toMatchObject({ host: "127.0.0.1", port: expect.any(Number) })
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
    expect(Object.keys(server)).not.toContain("apiKey")
    // and on POSIX its credential is persisted with owner-only permissions
    expect(credentials).toEqual({ version: 1, apiKey: server.apiKey })
    if (process.platform !== "win32") expect(fs.statSync(server.credentialsFile).mode & 0o777).toBe(0o600)

    // when unary and streaming RPCs omit or misuse the credential
    const missing = rpcClient(server, "")
    const wrong = rpcClient(server, "wrong")

    // then both forms fail with generic unauthenticated errors that omit the real key
    for (const request of [
        () => missing.listWorkflows({}),
        () => wrong.listWorkflows({}),
        () => Array.fromAsync(wrong.watchRun({ runId: "missing" }))
    ]) {
        await expect(request()).rejects.toMatchObject({ code: Code.Unauthenticated })
        await request().catch((error: unknown) => expect(String(error)).not.toContain(server.apiKey))
    }

    // when the server restarts over the same Loopy instance
    const apiKey = server.apiKey
    await server.close()
    const restarted = await listen(loopy, { port: 0 })
    onTestFinished(() => restarted.close())

    // then it reuses the credential and the underlying Loopy remains usable
    expect(restarted.apiKey).toBe(apiKey)
    expect(await loopy.runs.list()).toEqual([])
})

test("serve owns process signal handling and the Loopy lifecycle", async () => {
    // given a fresh Loopy instance and the existing process signal listeners
    const { loopy } = tempLoopy()
    const existingSigint = process.listeners("SIGINT")
    const existingSigterm = process.listeners("SIGTERM")

    // when the high-level server starts
    const server = await serve(loopy, { port: 0 })
    onTestFinished(() => server.close())

    // then it installs one handler for each termination signal and leaves Loopy usable
    const sigintHandler = process.listeners("SIGINT").find((listener) => !existingSigint.includes(listener))
    expect(sigintHandler).toBeDefined()
    expect(process.listeners("SIGTERM").filter((listener) => !existingSigterm.includes(listener))).toHaveLength(1)
    expect(loopy.closed).toBe(false)
    expect(loopy.db.open).toBe(true)

    // when close is called explicitly twice
    await Promise.all([server.close(), server.close()])

    // then transport and database cleanup happen once and both signal handlers are removed
    expect(loopy.closed).toBe(true)
    expect(loopy.db.open).toBe(false)
    expect(process.listeners("SIGINT")).toEqual(existingSigint)
    expect(process.listeners("SIGTERM")).toEqual(existingSigterm)
})

test.skipIf(process.platform === "win32")(
    "a served process shuts down and terminates on SIGINT while work keeps it alive",
    async () => {
        // given a real server process with an active run stream and a pending timer holding its event loop open
        const dir = tempDir("loopy-signal-")
        const child = spawn(process.execPath, ["--import", "tsx", path.join(fixtures, "serve-signal.ts")], {
            env: { ...process.env, LOOPY_DIR: dir },
            stdio: ["ignore", "pipe", "pipe"]
        })
        onTestFinished(() => {
            child.kill("SIGKILL")
        })
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
            child.once("exit", (code, signal) => resolve({ code, signal }))
        )
        const started = z
            .object({ url: z.string(), apiKey: z.string(), runId: z.string() })
            .parse(JSON.parse(await firstLine(child.stdout!)))
        const client = createClient(
            LoopyService,
            createConnectTransport({ httpVersion: "1.1", baseUrl: started.url, interceptors: [bearer(started.apiKey)] })
        )
        const runStream = client.watchRun({ runId: started.runId })[Symbol.asyncIterator]()
        await nextRunningStep(runStream, "wait:never")
        const pending = runStream.next().catch((error: unknown) => error)

        // when the process is interrupted
        child.kill("SIGINT")

        // then the active stream reports shutdown rather than a dropped connection
        expect(await pending).toMatchObject({ code: Code.Unavailable })
        // and the process terminates from the signal instead of outliving its closed database
        expect(await exited).toMatchObject({ signal: "SIGINT" })
    }
)

test("close returns without waiting out the keep-alive timeout of an abandoned stream", async () => {
    // given a run watched through a stream the client stops consuming without cancelling
    const { loopy } = tempLoopy()
    registerApproval(loopy, z.number())
    const server = await testServer(loopy)
    const client = rpcClient(server)
    const started = await client.startRun({ workflowName: "approval", inputJson: json({ id: "a", value: 1 }) })
    await nextRunningStep(client.watchRun({ runId: started.runId })[Symbol.asyncIterator](), "wait:approve:a")

    // when the server is closed while that connection is still open
    const startedClosingAt = performance.now()
    await server.close()
    const closingTook = performance.now() - startedClosingAt

    // then the socket left idle by the aborted stream is reaped instead of timing out
    expect(closingTook).toBeLessThan(2000)
})

test("serve closes its Loopy instance when startup fails", async () => {
    // given a fresh Loopy instance
    const { loopy } = tempLoopy()

    // when the high-level server is started with an invalid address
    await expect(serve(loopy, { host: "", port: 0 })).rejects.toThrow(/host must not be empty/)

    // then the instance it took ownership of is closed
    expect(loopy.closed).toBe(true)
    expect(loopy.db.open).toBe(false)
})

test("rejects malformed credential files without replacing them", async () => {
    // given an existing malformed credential file
    const { loopy } = tempLoopy()
    const credentialsFile = path.join(loopy.loopyDir, "credentials.json")
    fs.writeFileSync(credentialsFile, "not-json")
    fs.chmodSync(credentialsFile, 0o644)

    // when starting a server
    // then startup fails without replacing the file contents
    await expect(listen(loopy, { port: 0 })).rejects.toThrow(/malformed/)
    expect(fs.readFileSync(credentialsFile, "utf8")).toBe("not-json")
    // and on POSIX the credential file is still restricted to its owner
    if (process.platform !== "win32") expect(fs.statSync(credentialsFile).mode & 0o777).toBe(0o600)
})

test("resumes an interrupted run through a restarted server", async () => {
    // given a workflow waiting for an event on one Loopy process
    const { loopy, reopen } = tempLoopy()
    const register = (instance: Loopy) =>
        instance.registerWorkflow(
            "approval",
            { input: z.null(), output: z.number(), key: () => "approval-key" },
            async () =>
                (await instance.waitFor({ key: "resume-approval", schema: z.object({ value: z.number() }) })).value
        )
    register(loopy)
    const firstServer = await testServer(loopy)
    const firstClient = rpcClient(firstServer)
    const started = await firstClient.startRun({ workflowName: "approval", inputJson: "null" })
    const firstWatch = firstClient.watchRun({ runId: started.runId })[Symbol.asyncIterator]()
    await nextRunningStep(firstWatch, "wait:resume-approval")
    const apiKey = firstServer.apiKey
    await firstServer.close()

    // when a new Loopy instance and server resume the persisted run
    const second = reopen()
    register(second)
    const secondServer = await listen(second, { port: 0 })
    onTestFinished(() => secondServer.close())
    const secondClient = rpcClient(secondServer)
    const resumed = await secondClient.resumeRun({ runId: started.runId })
    const secondWatch = secondClient.watchRun({ runId: resumed.runId })[Symbol.asyncIterator]()
    await nextRunningStep(secondWatch, "wait:resume-approval")
    await secondClient.emitEvent({ key: "resume-approval", inputJson: json({ value: 9 }) })
    await Array.fromAsync({
        [Symbol.asyncIterator]: () => secondWatch
    })

    // then the same run succeeds and the server credential remains stable
    expect(resumed.runId).toBe(started.runId)
    expect(secondServer.apiKey).toBe(apiKey)
    expect(await runOutput(second, resumed.runId)).toBe(9)
})

test("startRun reports input persisted under an incompatible schema as a failed precondition", async () => {
    // given an interrupted run persisted under a numeric input schema
    const { loopy, reopen } = tempLoopy()
    registerApproval(loopy, z.number())
    const firstServer = await testServer(loopy)
    const firstClient = rpcClient(firstServer)
    const started = await firstClient.startRun({ workflowName: "approval", inputJson: json({ id: "a", value: 1 }) })
    await nextRunningStep(firstClient.watchRun({ runId: started.runId })[Symbol.asyncIterator](), "wait:approve:a")
    await firstServer.close()

    // when the workflow is re-registered with a string-valued schema and started again with matching input
    const { client } = await reopenWithIncompatibleInput(reopen)
    const outcome = await client
        .startRun({ workflowName: "approval", inputJson: json({ id: "a", value: "1" }) })
        .catch((error: unknown) => error)

    // then the persisted input is named as the failed precondition
    const message = incompatibleInputOutcome(outcome)
    expect(message).toContain('input no longer matches the input schema of workflow "approval"')
    // and the caller's own valid input is not blamed for the stored mismatch
    expect(message).not.toContain("Workflow input is invalid")
})

test("resumeRun reports input persisted under an incompatible schema as a failed precondition", async () => {
    // given an interrupted run persisted under a numeric input schema
    const { loopy, reopen } = tempLoopy()
    registerApproval(loopy, z.number())
    const firstServer = await testServer(loopy)
    const firstClient = rpcClient(firstServer)
    const started = await firstClient.startRun({ workflowName: "approval", inputJson: json({ id: "a", value: 1 }) })
    await nextRunningStep(firstClient.watchRun({ runId: started.runId })[Symbol.asyncIterator](), "wait:approve:a")
    await firstServer.close()

    // when the workflow is re-registered with a string-valued schema and the run is resumed
    const { loopy: second, client } = await reopenWithIncompatibleInput(reopen)
    const outcome = await client.resumeRun({ runId: started.runId }).catch((error: unknown) => error)

    // then the persisted input is named as the failed precondition
    expect(incompatibleInputOutcome(outcome)).toContain(
        `Run "${started.runId}" input no longer matches the input schema of workflow "approval"`
    )
    // and the attempt is left untouched rather than being dispatched
    expect(await second.runs.get(started.runId)).toMatchObject({ status: "interrupted", attempt: 1 })
})

test("rerunRun reports input persisted under an incompatible schema as a failed precondition", async () => {
    // given a succeeded run persisted under a numeric input schema
    const { loopy, reopen } = tempLoopy()
    registerApproval(loopy, z.number())
    const firstServer = await testServer(loopy)
    const firstClient = rpcClient(firstServer)
    const started = await firstClient.startRun({ workflowName: "approval", inputJson: json({ id: "a", value: 1 }) })
    await nextRunningStep(firstClient.watchRun({ runId: started.runId })[Symbol.asyncIterator](), "wait:approve:a")
    await firstClient.emitEvent({ key: "approve:a", inputJson: json({ value: 7 }) })
    await runOutput(loopy, started.runId)
    await firstServer.close()

    // when the workflow is re-registered with a string-valued schema and the run is rerun from its first step
    const { loopy: second, client } = await reopenWithIncompatibleInput(reopen)
    const outcome = await client
        .rerunRun({ runId: started.runId, fromStepKey: "record" })
        .catch((error: unknown) => error)

    // then the persisted input is named as the failed precondition
    expect(incompatibleInputOutcome(outcome)).toContain(
        `Run "${started.runId}" input no longer matches the input schema of workflow "approval"`
    )
    // and no further attempt is recorded
    expect(await second.runs.list({ workflowName: "approval" })).toHaveLength(1)
})

test("requires TLS for public binds and serves a real HTTPS Connect request", async () => {
    // given a fresh Loopy instance and a test certificate
    const { loopy } = tempLoopy()
    const key = fs.readFileSync(path.join(fixtures, "localhost-key.pem"))
    const cert = fs.readFileSync(path.join(fixtures, "localhost-cert.pem"))

    // when binding publicly without TLS
    // then startup is rejected before listening
    await expect(listen(loopy, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/TLS is required/)

    // when binding publicly with a valid certificate
    const server = await listen(loopy, { host: "0.0.0.0", port: 0, tls: { key, cert } })
    onTestFinished(() => server.close())
    const client = rpcClient({ ...server, url: `https://127.0.0.1:${server.port}` }, server.apiKey, { ca: cert })

    // then a real authenticated HTTPS request succeeds
    expect(await client.listWorkflows({})).toMatchObject({ workflows: [] })
})

test("maps invalid requests to stable Connect errors", async () => {
    // given a workflow with a validated input
    const { loopy } = tempLoopy()
    loopy.registerWorkflow(
        "validated",
        { input: z.object({ value: z.number() }), output: z.number(), key: () => "validated" },
        async (input) => input.value
    )
    const server = await testServer(loopy)
    const client = rpcClient(server)

    // when requests contain bad input or filters
    // then each failure is mapped to its public Connect category
    await expect(
        client.startRun({ workflowName: "validated", inputJson: json({ value: "bad" }) })
    ).rejects.toMatchObject({
        code: Code.InvalidArgument
    })
    await expect(client.startRun({ workflowName: "validated", inputJson: "{" })).rejects.toMatchObject({
        code: Code.InvalidArgument
    })
    await expect(client.emitEvent({ key: "malformed", inputJson: "[" })).rejects.toMatchObject({
        code: Code.InvalidArgument
    })
    await expect(client.emitEvent({ key: "no-payload" })).rejects.toMatchObject({
        code: Code.InvalidArgument
    })
    await expect(client.listRuns({ limit: 0 })).rejects.toMatchObject({ code: Code.InvalidArgument })
})

test("maps workflow lifecycle LoopyError codes to stable Connect errors", async () => {
    // given workflows with failed, succeeded, rerun and active lifecycle states
    const { loopy, reopen } = tempLoopy()
    let shouldFail = true
    loopy.registerWorkflow(
        "lifecycle",
        { input: z.object({ id: z.string() }), output: z.string(), key: (input) => input.id },
        async () =>
            loopy.step("compute", z.string(), async () => {
                if (shouldFail) throw new Error("boom")
                return "done"
            })
    )
    loopy.registerWorkflow(
        "waiting",
        { input: z.null(), output: z.number(), key: () => "waiting" },
        async () => (await loopy.waitFor({ key: "lifecycle-go", schema: z.object({ value: z.number() }) })).value
    )
    const server = await testServer(loopy)
    const client = rpcClient(server)
    const failedId = (await client.startRun({ workflowName: "lifecycle", inputJson: json({ id: "failed" }) })).runId
    await expect(runOutput(loopy, failedId)).rejects.toThrow("boom")

    // when starting a failed key and resuming missing or terminal runs
    // then the matching lifecycle categories are returned
    await expect(
        client.startRun({ workflowName: "lifecycle", inputJson: json({ id: "failed" }) })
    ).rejects.toMatchObject({
        code: Code.FailedPrecondition
    })
    await expect(client.resumeRun({ runId: "missing" })).rejects.toMatchObject({ code: Code.NotFound })
    shouldFail = false
    const succeededId = (await client.startRun({ workflowName: "lifecycle", inputJson: json({ id: "succeeded" }) }))
        .runId
    expect(await runOutput(loopy, succeededId)).toBe("done")
    await expect(client.resumeRun({ runId: succeededId })).rejects.toMatchObject({
        code: Code.FailedPrecondition
    })

    // when selectors do not identify steps in the requested run
    // then watch and rerun report invalid arguments
    await expect(Array.fromAsync(client.watchRun({ runId: succeededId, fromStepId: "missing" }))).rejects.toMatchObject(
        { code: Code.InvalidArgument }
    )
    await expect(client.rerunRun({ runId: succeededId, fromStepKey: "missing" })).rejects.toMatchObject({
        code: Code.InvalidArgument
    })

    // when rerunning an active run
    const activeId = (await client.startRun({ workflowName: "waiting", inputJson: "null" })).runId
    const activeWatch = client.watchRun({ runId: activeId })[Symbol.asyncIterator]()
    await nextRunningStep(activeWatch, "wait:lifecycle-go")
    // then concurrent attempts are rejected as a failed precondition
    await expect(client.rerunRun({ runId: activeId, fromStepKey: "wait:lifecycle-go" })).rejects.toMatchObject({
        code: Code.FailedPrecondition
    })
    await client.emitEvent({ key: "lifecycle-go", inputJson: json({ value: 1 }) })
    await Array.fromAsync({ [Symbol.asyncIterator]: () => activeWatch })

    // when an older attempt is resumed or rerun
    shouldFail = false
    const latestId = (await client.rerunRun({ runId: failedId, fromStepKey: "compute" })).runId
    expect(await runOutput(loopy, latestId)).toBe("done")
    // then only the latest attempt remains eligible
    await expect(client.resumeRun({ runId: failedId })).rejects.toMatchObject({ code: Code.FailedPrecondition })
    await expect(client.rerunRun({ runId: failedId, fromStepKey: "compute" })).rejects.toMatchObject({
        code: Code.FailedPrecondition
    })

    // when a persisted run is accessed through an instance without its workflow registration
    const unregistered = reopen()
    const unregisteredServer = await testServer(unregistered)
    const unregisteredClient = rpcClient(unregisteredServer)
    // then resume and rerun expose failed preconditions while discovery and start expose not found
    await expect(unregisteredClient.resumeRun({ runId: succeededId })).rejects.toMatchObject({
        code: Code.FailedPrecondition
    })
    await expect(unregisteredClient.rerunRun({ runId: succeededId, fromStepKey: "compute" })).rejects.toMatchObject({
        code: Code.FailedPrecondition
    })
    await expect(unregisteredClient.getWorkflow({ name: "lifecycle" })).rejects.toMatchObject({ code: Code.NotFound })
    await expect(unregisteredClient.startRun({ workflowName: "lifecycle" })).rejects.toMatchObject({
        code: Code.NotFound
    })
})

test("maps coded resource lookup failures without inspecting messages", async () => {
    // given a real server and a completed session with one message
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({
        kind: "llm",
        client: "fake-llm",
        provider: "fake",
        model: "fake"
    })
    recorder.addMessage("assistant", "done")
    recorder.succeed()
    const server = await testServer(loopy)
    const client = rpcClient(server)

    // when missing runs, artifacts, sessions and session messages are requested
    // then each coded resource failure maps to its intended public category
    await expect(client.getRun({ runId: "missing" })).rejects.toMatchObject({ code: Code.NotFound })
    await expect(Array.fromAsync(client.watchRun({ runId: "missing" }))).rejects.toMatchObject({
        code: Code.NotFound
    })
    await expect(client.rerunRun({ runId: "missing", fromStepKey: "step" })).rejects.toMatchObject({
        code: Code.NotFound
    })
    await expect(client.getArtifact({ artifactId: "missing" })).rejects.toMatchObject({ code: Code.NotFound })
    await expect(Array.fromAsync(client.readArtifact({ artifactId: "missing" }))).rejects.toMatchObject({
        code: Code.NotFound
    })
    await expect(client.getSession({ sessionId: "missing" })).rejects.toMatchObject({ code: Code.NotFound })
    await expect(Array.fromAsync(client.watchSession({ sessionId: "missing" }))).rejects.toMatchObject({
        code: Code.NotFound
    })
    await expect(
        Array.fromAsync(client.watchSession({ sessionId: recorder.id, afterMessageId: "missing" }))
    ).rejects.toMatchObject({ code: Code.InvalidArgument })
})

test("maps a missing artifact backing file to not found", async () => {
    // given an artifact whose persisted file has been deleted
    const { loopy } = tempLoopy()
    const artifact = await testRun(loopy, async () => loopy.artifacts.writeText("report", "hello"))
    fs.unlinkSync(path.join(loopy.loopyDir, artifact.file))
    const server = await testServer(loopy)
    const client = rpcClient(server)

    // when its content is requested through the server
    const result = Array.fromAsync(client.readArtifact({ artifactId: artifact.id }))

    // then the missing file is exposed as a missing artifact
    await expect(result).rejects.toMatchObject({ code: Code.NotFound })
})

test("cancels an artifact stream when its response generator returns early", async () => {
    // given an artifact stream and a request context that has not been aborted
    const { loopy } = tempLoopy()
    let canceled = false
    loopy.artifacts.read = async () => ({
        stream: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1]))
            },
            cancel() {
                canceled = true
            }
        })
    })
    const context = createHandlerContext({
        service: LoopyService,
        method: LoopyService.method.readArtifact,
        protocolName: "connect",
        requestMethod: "POST",
        url: "http://localhost/loopy.server.v1.LoopyService/ReadArtifact"
    })

    // when the response generator returns after its first chunk
    const request = create(ReadArtifactRequestSchema, { artifactId: "artifact" })
    const stream = loopyService(loopy).readArtifact(request, context)[Symbol.asyncIterator]()
    await stream.next()
    await stream.return?.()

    // then the underlying artifact stream is canceled
    expect(context.signal.aborted).toBe(false)
    expect(canceled).toBe(true)
})

test("exposes persisted LoopyError codes on runs and steps", async () => {
    // given a workflow whose durable step fails with a semantic core error
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("coded", { input: z.null(), output: z.void(), key: () => "coded" }, async () =>
        loopy.step("coded", z.void(), async () => loopy.waitForAny([]))
    )
    const server = await testServer(loopy)
    const client = rpcClient(server)

    // when the failed run is fetched through protobuf
    const runId = (await client.startRun({ workflowName: "coded", inputJson: "null" })).runId
    await expect(runOutput(loopy, runId)).rejects.toThrow("at least one event source")
    const run = (await client.getRun({ runId })).run!

    // then the string code is exposed beside both persisted error messages
    expect(run).toMatchObject({
        error: "waitForAny requires at least one event source",
        errorCode: "event_sources_empty"
    })
    expect(run.steps[0]).toMatchObject({
        error: "waitForAny requires at least one event source",
        errorCode: "event_sources_empty"
    })
})

test("does not classify an ordinary error from message text", async () => {
    // given a registered workflow whose key function throws text matching a lifecycle error
    const { loopy } = tempLoopy()
    loopy.registerWorkflow(
        "spoof",
        {
            input: z.null(),
            output: z.void(),
            key: () => {
                throw new Error('Run "spoof" has failed; rerun it from a step to start a new attempt')
            }
        },
        async () => undefined
    )
    const server = await testServer(loopy)
    const client = rpcClient(server)

    // when the ordinary error crosses the RPC boundary
    // then matching text does not turn it into a failed precondition
    await expect(client.startRun({ workflowName: "spoof", inputJson: "null" })).rejects.toMatchObject({
        code: Code.Internal
    })
})

test("closing a server rejects active streams without closing Loopy", async () => {
    // given a live run, session, artifact and active Connect streams
    const { loopy } = tempLoopy()
    loopy.registerWorkflow(
        "waiting",
        { input: z.null(), output: z.number(), key: () => "waiting" },
        async () => (await loopy.waitFor({ key: "never", schema: z.object({ value: z.number() }) })).value
    )
    const recorder = loopy.sessions.create({
        kind: "llm",
        client: "fake-llm",
        provider: "fake",
        model: "fake"
    })
    recorder.addMessage("assistant", "working")
    let artifactCanceled = false
    loopy.artifacts.read = async () => ({
        stream: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1]))
            },
            cancel() {
                artifactCanceled = true
            }
        })
    })
    const server = await listen(loopy, { port: 0 })
    onTestFinished(() => server.close())
    const client = rpcClient(server)
    const started = await client.startRun({ workflowName: "waiting", inputJson: "null" })
    const runStream = client.watchRun({ runId: started.runId })[Symbol.asyncIterator]()
    await nextRunningStep(runStream, "wait:never")
    const sessionStream = client.watchSession({ sessionId: recorder.id })[Symbol.asyncIterator]()
    await sessionStream.next()
    const artifactStream = client.readArtifact({ artifactId: "artifact" })[Symbol.asyncIterator]()
    await artifactStream.next()
    const pending = [runStream.next(), sessionStream.next(), artifactStream.next()].map((result) =>
        result.catch((error: unknown) => error)
    )

    // when close is called twice while the streams are pending
    await Promise.all([server.close(), server.close()])
    const outcomes = await Promise.all(pending)

    // then every stream reports shutdown and the supplied Loopy database remains open
    expect(outcomes).toHaveLength(3)
    for (const outcome of outcomes) {
        expect(outcome).toBeInstanceOf(ConnectError)
        expect(outcome).toMatchObject({ code: Code.Unavailable })
    }
    expect(artifactCanceled).toBe(true)
    expect((await loopy.runs.get(started.runId)).status).toBe("running")
    expect((await loopy.sessions.get(recorder.id)).status).toBe("running")
})
