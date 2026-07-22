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
import { ExecutionStatus, LoopyService, ReadArtifactRequestSchema, StepKind } from "@loopy/server/proto"
import { runOutput, tempGitRepo, tempLoopy, testRun } from "@loopy/test-utils"
import { expect, onTestFinished, test } from "vitest"
import * as z from "zod"
import { serve, type LoopyServer } from "../src"
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
    const server = await serve(loopy, { port: 0 })
    onTestFinished(() => server.close())
    return server
}

function json(value: unknown): string {
    return JSON.stringify(value)
}

function native(value: string | undefined): unknown {
    return value === undefined ? undefined : JSON.parse(value)
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
            const approval = await loopy.waitFor(`approval:${input.id}`, z.object({ ok: z.boolean() }))
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
    expect(session).toMatchObject({ provider: "fake-llm", status: ExecutionStatus.SUCCEEDED })
    expect(
        (await Array.fromAsync(client.watchSession({ sessionId }))).map((response) => response.message!.content)
    ).toEqual(session.messages.map((message) => message.content))

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

test("distinguishes absent void values from present JSON null across protobuf", async () => {
    // given void and null workflows with matching durable steps
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("void-output", { input: z.null(), output: z.void(), key: () => "void" }, async () =>
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
    const voidId = (await client.startRun({ workflowName: "void-output", inputJson: "null" })).runId
    const nullId = (await client.startRun({ workflowName: "null-output", inputJson: "null" })).runId
    await Promise.all([runOutput(loopy, voidId), runOutput(loopy, nullId)])
    const voidRun = (await client.getRun({ runId: voidId })).run!
    const nullRun = (await client.getRun({ runId: nullId })).run!

    // then void omits its output schema and values while JSON null remains present as exact text
    expect(voidDefinition.outputSchemaJson).toBeUndefined()
    expect(nullDefinition.outputSchemaJson).toBeDefined()
    expect(native(voidDefinition.inputSchemaJson)).not.toHaveProperty("$schema")
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
    // and its credential is persisted with owner-only permissions
    expect(credentials).toEqual({ version: 1, apiKey: server.apiKey })
    expect(fs.statSync(server.credentialsFile).mode & 0o777).toBe(0o600)

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
    const restarted = await serve(loopy, { port: 0 })
    onTestFinished(() => restarted.close())

    // then it reuses the credential and the underlying Loopy remains usable
    expect(restarted.apiKey).toBe(apiKey)
    expect(await loopy.runs.list()).toEqual([])
})

test("rejects malformed credential files without replacing them", async () => {
    // given an existing malformed credential file
    const { loopy } = tempLoopy()
    const credentialsFile = path.join(loopy.loopyDir, "credentials.json")
    fs.writeFileSync(credentialsFile, "not-json")
    fs.chmodSync(credentialsFile, 0o644)

    // when starting a server
    // then startup fails without replacing the file contents
    await expect(serve(loopy, { port: 0 })).rejects.toThrow(/malformed/)
    expect(fs.readFileSync(credentialsFile, "utf8")).toBe("not-json")
    // and the credential file is still restricted to its owner
    expect(fs.statSync(credentialsFile).mode & 0o777).toBe(0o600)
})

test("resumes an interrupted run through a restarted server", async () => {
    // given a workflow waiting for an event on one Loopy process
    const { loopy, reopen } = tempLoopy()
    const register = (instance: Loopy) =>
        instance.registerWorkflow(
            "approval",
            { input: z.null(), output: z.number(), key: () => "approval-key" },
            async () => (await instance.waitFor("resume-approval", z.object({ value: z.number() }))).value
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
    const secondServer = await serve(second, { port: 0 })
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

test("requires TLS for public binds and serves a real HTTPS Connect request", async () => {
    // given a fresh Loopy instance and a test certificate
    const { loopy } = tempLoopy()
    const key = fs.readFileSync(path.join(fixtures, "localhost-key.pem"))
    const cert = fs.readFileSync(path.join(fixtures, "localhost-cert.pem"))

    // when binding publicly without TLS
    // then startup is rejected before listening
    await expect(serve(loopy, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/TLS is required/)

    // when binding publicly with a valid certificate
    const server = await serve(loopy, { host: "0.0.0.0", port: 0, tls: { key, cert } })
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
        async () => (await loopy.waitFor("lifecycle-go", z.object({ value: z.number() }))).value
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
    const recorder = loopy.sessions.create({ kind: "llm", provider: "fake", model: "fake" })
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
    await expect(runOutput(loopy, runId)).rejects.toThrow("at least one event definition")
    const run = (await client.getRun({ runId })).run!

    // then the string code is exposed beside both persisted error messages
    expect(run).toMatchObject({
        error: "waitForAny requires at least one event definition",
        errorCode: "event_definitions_empty"
    })
    expect(run.steps[0]).toMatchObject({
        error: "waitForAny requires at least one event definition",
        errorCode: "event_definitions_empty"
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

test("closing a server terminates active watches without closing Loopy", async () => {
    // given a live run and an active Connect watch
    const { loopy } = tempLoopy()
    loopy.registerWorkflow(
        "waiting",
        { input: z.null(), output: z.number(), key: () => "waiting" },
        async () => (await loopy.waitFor("never", z.object({ value: z.number() }))).value
    )
    const server = await serve(loopy, { port: 0 })
    onTestFinished(() => server.close())
    const client = rpcClient(server)
    const started = await client.startRun({ workflowName: "waiting", inputJson: "null" })
    const watch = client.watchRun({ runId: started.runId })[Symbol.asyncIterator]()
    await nextRunningStep(watch, "wait:never")
    const pending = watch.next()

    // when close is called twice while the stream is pending
    await Promise.all([server.close(), server.close()])
    const outcome = await pending.then(
        (value) => value,
        (error: unknown) => error
    )

    // then the watch terminates and the supplied Loopy database remains open
    if (outcome instanceof ConnectError) expect([Code.Canceled, Code.Unavailable]).toContain(outcome.code)
    else expect(outcome).toMatchObject({ done: true })
    expect((await loopy.runs.get(started.runId)).status).toBe("running")
})
