import * as fs from "node:fs"
import * as path from "node:path"
import { create } from "@bufbuild/protobuf"
import { Code, ConnectError, createHandlerContext } from "@connectrpc/connect"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { ClankHouseService, ExecutionStatus, ReadArtifactRequestSchema } from "@clankhouse/protocol"
import { runOutput, tempClankHouse, testRun, testSession } from "@clankhouse/test-utils"
import { expect, onTestFinished, test } from "vitest"
import * as z from "zod"
import { listen } from "../src"
import { clankhouseService } from "../src/service"
import { nextRunningStep, rpcClient, testServer } from "./helpers"

function json(value: unknown): string {
    return JSON.stringify(value)
}

function registerApproval(instance: ClankHouse, value: z.ZodTypeAny): void {
    instance.registerWorkflow(
        "approval",
        { input: z.object({ id: z.string(), value }), output: z.number(), key: (input) => input.id },
        async (input) => {
            await instance.step("record", z.number(), async () => 1)
            return (
                await instance.waitFor({
                    key: `approve:${input.id}`,
                    schema: z.object({ value: z.number() })
                })
            ).value
        }
    )
}

async function reopenWithIncompatibleInput(
    reopen: () => ClankHouse
): Promise<{ clankhouse: ClankHouse; client: ReturnType<typeof rpcClient> }> {
    const second = reopen()
    registerApproval(second, z.string())
    const server = await listen(second, { port: 0 })
    onTestFinished(() => server.close())
    return { clankhouse: second, client: rpcClient(server) }
}

function incompatibleInputOutcome(outcome: unknown): string {
    expect(outcome).toBeInstanceOf(ConnectError)
    expect(outcome).toMatchObject({ code: Code.FailedPrecondition })
    return (outcome as ConnectError).rawMessage
}

test("resumes an interrupted run through a restarted server", async () => {
    // given a workflow waiting for an event on one ClankHouse process
    const { clankhouse, reopen } = tempClankHouse()
    const register = (instance: ClankHouse) =>
        instance.registerWorkflow(
            "approval",
            { input: z.null(), output: z.number(), key: () => "approval-key" },
            async () =>
                (
                    await instance.waitFor({
                        key: "resume-approval",
                        schema: z.object({ value: z.number() })
                    })
                ).value
        )
    register(clankhouse)
    const firstServer = await testServer(clankhouse)
    const firstClient = rpcClient(firstServer)
    const started = await firstClient.startRun({ workflowName: "approval", inputJson: "null" })
    const firstWatch = firstClient.watchRun({ runId: started.runId })[Symbol.asyncIterator]()
    await nextRunningStep(firstWatch, "wait:resume-approval")
    const apiKey = firstServer.apiKey
    await firstServer.close()

    // when a new ClankHouse instance and server resume the persisted run
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

test("startRun reports an existing interrupted run without resuming it", async () => {
    // given an interrupted run persisted by a closed server
    const { clankhouse, reopen } = tempClankHouse()
    registerApproval(clankhouse, z.number())
    const firstServer = await testServer(clankhouse)
    const firstClient = rpcClient(firstServer)
    const started = await firstClient.startRun({ workflowName: "approval", inputJson: json({ id: "a", value: 1 }) })
    expect(started.status).toBe(ExecutionStatus.RUNNING)
    await nextRunningStep(firstClient.watchRun({ runId: started.runId })[Symbol.asyncIterator](), "wait:approve:a")
    await firstServer.close()

    // when a restarted server is asked to start the same key
    const second = reopen()
    registerApproval(second, z.number())
    const secondServer = await listen(second, { port: 0 })
    onTestFinished(() => secondServer.close())
    const restarted = await rpcClient(secondServer).startRun({
        workflowName: "approval",
        inputJson: json({ id: "a", value: 1 })
    })

    // then the existing run is reported as interrupted
    expect(restarted).toMatchObject({ runId: started.runId, status: ExecutionStatus.INTERRUPTED })
    // and it stays interrupted instead of being resumed
    expect((await second.runs.get(started.runId)).status).toBe("interrupted")
})

test("resumeRun reports input persisted under an incompatible schema as a failed precondition", async () => {
    // given an interrupted run persisted under a numeric input schema
    const { clankhouse, reopen } = tempClankHouse()
    registerApproval(clankhouse, z.number())
    const firstServer = await testServer(clankhouse)
    const firstClient = rpcClient(firstServer)
    const started = await firstClient.startRun({ workflowName: "approval", inputJson: json({ id: "a", value: 1 }) })
    await nextRunningStep(firstClient.watchRun({ runId: started.runId })[Symbol.asyncIterator](), "wait:approve:a")
    await firstServer.close()

    // when the workflow is re-registered with a string-valued schema and the run is resumed
    const { clankhouse: second, client } = await reopenWithIncompatibleInput(reopen)
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
    const { clankhouse, reopen } = tempClankHouse()
    registerApproval(clankhouse, z.number())
    const firstServer = await testServer(clankhouse)
    const firstClient = rpcClient(firstServer)
    const started = await firstClient.startRun({ workflowName: "approval", inputJson: json({ id: "a", value: 1 }) })
    await nextRunningStep(firstClient.watchRun({ runId: started.runId })[Symbol.asyncIterator](), "wait:approve:a")
    await firstClient.emitEvent({ key: "approve:a", inputJson: json({ value: 7 }) })
    await runOutput(clankhouse, started.runId)
    await firstServer.close()

    // when the workflow is re-registered with a string-valued schema and the run is rerun from its first step
    const { clankhouse: second, client } = await reopenWithIncompatibleInput(reopen)
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

test("maps invalid requests to stable Connect errors", async () => {
    // given a workflow with a validated input
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow(
        "validated",
        { input: z.object({ value: z.number() }), output: z.number(), key: () => "validated" },
        async (input) => input.value
    )
    const server = await testServer(clankhouse)
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

test("maps workflow lifecycle ClankHouseError codes to stable Connect errors", async () => {
    // given workflows with failed, succeeded, rerun and active lifecycle states
    const { clankhouse, reopen } = tempClankHouse()
    let shouldFail = true
    clankhouse.registerWorkflow(
        "lifecycle",
        { input: z.object({ id: z.string() }), output: z.string(), key: (input) => input.id },
        async () =>
            clankhouse.step("compute", z.string(), async () => {
                if (shouldFail) throw new Error("boom")
                return "done"
            })
    )
    clankhouse.registerWorkflow(
        "waiting",
        { input: z.null(), output: z.number(), key: () => "waiting" },
        async () => (await clankhouse.waitFor({ key: "lifecycle-go", schema: z.object({ value: z.number() }) })).value
    )
    const server = await testServer(clankhouse)
    const client = rpcClient(server)
    const failedId = (await client.startRun({ workflowName: "lifecycle", inputJson: json({ id: "failed" }) })).runId
    await expect(runOutput(clankhouse, failedId)).rejects.toThrow("boom")

    // when starting a failed key
    // then the existing failed run is reported
    expect(await client.startRun({ workflowName: "lifecycle", inputJson: json({ id: "failed" }) })).toMatchObject({
        runId: failedId,
        status: ExecutionStatus.FAILED
    })

    // when resuming missing or terminal runs
    // then the matching lifecycle categories are returned
    await expect(client.resumeRun({ runId: "missing" })).rejects.toMatchObject({ code: Code.NotFound })
    shouldFail = false
    const succeededId = (await client.startRun({ workflowName: "lifecycle", inputJson: json({ id: "succeeded" }) }))
        .runId
    expect(await runOutput(clankhouse, succeededId)).toBe("done")
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
    expect(await runOutput(clankhouse, latestId)).toBe("done")
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
    const { clankhouse } = tempClankHouse()
    const recorder = await testSession(clankhouse, {
        kind: "llm",
        client: "fake-llm",
        provider: "fake",
        model: "fake"
    })
    recorder.addMessage("assistant", "done")
    recorder.succeed()
    const server = await testServer(clankhouse)
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
    const { clankhouse } = tempClankHouse()
    const artifact = await testRun(clankhouse, async () => clankhouse.artifacts.writeText("report", "hello"))
    fs.unlinkSync(path.join(clankhouse.clankhouseDir, artifact.file))
    const server = await testServer(clankhouse)
    const client = rpcClient(server)

    // when its content is requested through the server
    const result = Array.fromAsync(client.readArtifact({ artifactId: artifact.id }))

    // then the missing file is exposed as a missing artifact
    await expect(result).rejects.toMatchObject({ code: Code.NotFound })
})

test("cancels an artifact stream when its response generator returns early", async () => {
    // given an artifact stream and a request context that has not been aborted
    const { clankhouse } = tempClankHouse()
    let canceled = false
    clankhouse.artifacts.read = async () => ({
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
        service: ClankHouseService,
        method: ClankHouseService.method.readArtifact,
        protocolName: "connect",
        requestMethod: "POST",
        url: "http://localhost/clankhouse.server.v1.ClankHouseService/ReadArtifact"
    })

    // when the response generator returns after its first chunk
    const request = create(ReadArtifactRequestSchema, { artifactId: "artifact" })
    const stream = clankhouseService(clankhouse).readArtifact(request, context)[Symbol.asyncIterator]()
    await stream.next()
    await stream.return?.()

    // then the underlying artifact stream is canceled
    expect(context.signal.aborted).toBe(false)
    expect(canceled).toBe(true)
})

test("exposes persisted ClankHouseError codes on runs and steps", async () => {
    // given a workflow whose durable step fails with a semantic core error
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow("coded", { input: z.null(), output: z.void(), key: () => "coded" }, async () =>
        clankhouse.step("coded", z.void(), async () => clankhouse.waitForAny([]))
    )
    const server = await testServer(clankhouse)
    const client = rpcClient(server)

    // when the failed run is fetched through protobuf
    const runId = (await client.startRun({ workflowName: "coded", inputJson: "null" })).runId
    await expect(runOutput(clankhouse, runId)).rejects.toThrow("at least one event source")
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
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow(
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
    const server = await testServer(clankhouse)
    const client = rpcClient(server)

    // when the ordinary error crosses the RPC boundary
    // then matching text does not turn it into a failed precondition
    await expect(client.startRun({ workflowName: "spoof", inputJson: "null" })).rejects.toMatchObject({
        code: Code.Internal
    })
})
