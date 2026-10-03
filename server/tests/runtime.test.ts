import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Code, ConnectError, createClient } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-node"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { ClankHouseService } from "@clankhouse/protocol"
import { gate, runOutput, tempDir, tempClankHouse, testSession } from "@clankhouse/test-utils"
import { expect, onTestFinished, test } from "vitest"
import * as z from "zod"
import { listen, serve } from "../src"
import { bearer, freePort, nextRunningStep, rpcClient, testServer } from "./helpers"

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")

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

async function interruptRun(instance: ClankHouse, name: string): Promise<string> {
    const parked = gate()
    instance.registerWorkflow(
        name,
        { input: z.object({ value: z.number() }), output: z.number(), key: () => `${name}-key` },
        async (input) => {
            await instance.step("remember", z.number(), async () => input.value)
            await parked.released
            return 0
        }
    )
    const { runId } = instance.start(name, { value: 2 })
    await expect.poll(async () => (await instance.runs.get(runId)).steps.length).toBe(1)
    return runId
}

function registerDoubling(instance: ClankHouse, name: string, value: z.ZodTypeAny = z.number()): void {
    instance.registerWorkflow(
        name,
        { input: z.object({ value }), output: z.number(), key: () => `${name}-key` },
        async () => (await instance.step("remember", z.number(), async () => -1)) * 2
    )
}

test("persists a private credential and authenticates unary and streaming RPCs", async () => {
    // given a server using a fresh ClankHouse directory
    const { clankhouse } = tempClankHouse()
    const server = await testServer(clankhouse)
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

    // when the server restarts over the same ClankHouse instance
    const apiKey = server.apiKey
    await server.close()
    const restarted = await listen(clankhouse, { port: 0 })
    onTestFinished(() => restarted.close())

    // then it reuses the credential and the underlying ClankHouse remains usable
    expect(restarted.apiKey).toBe(apiKey)
    expect(await clankhouse.runs.list()).toEqual([])
})

test("serve resumes an interrupted run of a registered workflow at startup", async () => {
    // given an interrupted run persisted by another ClankHouse instance
    const { clankhouse, reopen } = tempClankHouse()
    const runId = await interruptRun(clankhouse, "double")
    const second = reopen()
    registerDoubling(second, "double")

    // when the high-level server starts on a reopened instance
    const server = await serve(second, { port: 0 })
    onTestFinished(() => server.close())

    // then the run is resumed and finishes from its replayed step
    expect(await runOutput(second, runId)).toBe(4)
})

test("serve with recover disabled leaves interrupted runs interrupted", async () => {
    // given an interrupted run persisted by another ClankHouse instance
    const { clankhouse, reopen } = tempClankHouse()
    const runId = await interruptRun(clankhouse, "double")
    const second = reopen()
    registerDoubling(second, "double")

    // when the high-level server starts with recovery disabled
    const server = await serve(second, { port: 0, recover: false })
    onTestFinished(() => server.close())

    // then the run stays interrupted
    expect((await second.runs.get(runId)).status).toBe("interrupted")
    // and the handle carries no recover result
    expect(server.recovered).toBeUndefined()
})

test("serve reports runs that fail to resume and still resumes the others", async () => {
    // given interrupted runs of two workflows
    const { clankhouse, reopen } = tempClankHouse()
    const incompatibleRunId = await interruptRun(clankhouse, "incompatible")
    const okRunId = await interruptRun(clankhouse, "double")
    // and one workflow re-registered with an input schema the stored input no longer matches
    const second = reopen()
    registerDoubling(second, "incompatible", z.string())
    registerDoubling(second, "double")
    const errors: Error[] = []

    // when the high-level server starts
    const server = await serve(second, { port: 0, onError: (error) => errors.push(error) })
    onTestFinished(() => server.close())

    // then the incompatible run is reported to onError
    expect(errors).toEqual([expect.objectContaining({ code: "workflow_input_incompatible" })])
    expect(errors[0]!.message).toContain(incompatibleRunId)
    // and the other run is resumed
    expect(await runOutput(second, okRunId)).toBe(4)
    // and the server is up
    expect((await rpcClient(server).getRun({ runId: okRunId })).run?.metadata).toMatchObject({ workflowName: "double" })
})

test("serve exposes the recover result on the returned handle", async () => {
    // given an interrupted run of a registered workflow and one of an unregistered workflow
    const { clankhouse, reopen } = tempClankHouse()
    const resumedRunId = await interruptRun(clankhouse, "double")
    const skippedRunId = await interruptRun(clankhouse, "unregistered")
    const second = reopen()
    registerDoubling(second, "double")

    // when the high-level server starts
    const server = await serve(second, { port: 0 })
    onTestFinished(() => server.close())

    // then the handle reports which runs were resumed and skipped
    expect(server.recovered).toEqual({
        resumed: [resumedRunId],
        skipped: [{ runId: skippedRunId, reason: "not_registered" }],
        failed: []
    })
})

test("serve owns process signal handling and the ClankHouse lifecycle", async () => {
    // given a fresh ClankHouse instance and the existing process signal listeners
    const { clankhouse } = tempClankHouse()
    const existingSigint = process.listeners("SIGINT")
    const existingSigterm = process.listeners("SIGTERM")

    // when the high-level server starts
    const server = await serve(clankhouse, { port: 0 })
    onTestFinished(() => server.close())

    // then it installs one handler for each termination signal and leaves ClankHouse usable
    const sigintHandler = process.listeners("SIGINT").find((listener) => !existingSigint.includes(listener))
    expect(sigintHandler).toBeDefined()
    expect(process.listeners("SIGTERM").filter((listener) => !existingSigterm.includes(listener))).toHaveLength(1)
    expect(clankhouse.closed).toBe(false)
    expect(clankhouse.db.open).toBe(true)

    // when close is called explicitly twice
    await Promise.all([server.close(), server.close()])

    // then transport and database cleanup happen once and both signal handlers are removed
    expect(clankhouse.closed).toBe(true)
    expect(clankhouse.db.open).toBe(false)
    expect(process.listeners("SIGINT")).toEqual(existingSigint)
    expect(process.listeners("SIGTERM")).toEqual(existingSigterm)
})

test.skipIf(process.platform === "win32")(
    "a served process shuts down and terminates on SIGINT while work keeps it alive",
    async () => {
        // given a real server process with an active run stream and a pending timer holding its event loop open
        const dir = tempDir("clankhouse-signal-")
        const child = spawn(process.execPath, ["--import", "tsx", path.join(fixtures, "serve-signal.ts")], {
            env: { ...process.env, CLANKHOUSE_DIR: dir },
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
            ClankHouseService,
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
    const { clankhouse } = tempClankHouse()
    registerApproval(clankhouse, z.number())
    const server = await testServer(clankhouse)
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

test("serve closes its ClankHouse instance when startup fails", async () => {
    // given a fresh ClankHouse instance
    const { clankhouse } = tempClankHouse()

    // when the high-level server is started with an invalid address
    await expect(serve(clankhouse, { host: "", port: 0 })).rejects.toThrow(/host must not be empty/)

    // then the instance it took ownership of is closed
    expect(clankhouse.closed).toBe(true)
    expect(clankhouse.db.open).toBe(false)
})

test("serve releases its listener and closes its ClankHouse instance when recovery throws", async () => {
    // given a ClankHouse instance whose runs table can no longer be read
    const { clankhouse } = tempClankHouse()
    clankhouse.db.exec("DROP TABLE runs")
    // and a free port
    const port = await freePort()

    // when the high-level server binds that port and then recovers
    const outcome = await serve(clankhouse, { port }).catch((error: unknown) => error)

    // then the original recovery error is rethrown
    expect(outcome).toMatchObject({ code: "SQLITE_ERROR", message: expect.stringContaining("no such table: runs") })
    // and the instance it took ownership of is closed
    expect(clankhouse.closed).toBe(true)
    expect(clankhouse.db.open).toBe(false)
    // and the port is free to bind again
    expect(await freePort(port)).toBe(port)
})

test("rejects malformed credential files without replacing them", async () => {
    // given an existing malformed credential file
    const { clankhouse } = tempClankHouse()
    const credentialsFile = path.join(clankhouse.clankhouseDir, "credentials.json")
    fs.writeFileSync(credentialsFile, "not-json")
    fs.chmodSync(credentialsFile, 0o644)

    // when starting a server
    // then startup fails without replacing the file contents
    await expect(listen(clankhouse, { port: 0 })).rejects.toThrow(/malformed/)
    expect(fs.readFileSync(credentialsFile, "utf8")).toBe("not-json")
    // and on POSIX the credential file is still restricted to its owner
    if (process.platform !== "win32") expect(fs.statSync(credentialsFile).mode & 0o777).toBe(0o600)
})

test("requires TLS for public binds and serves a real HTTPS Connect request", async () => {
    // given a fresh ClankHouse instance and a test certificate
    const { clankhouse } = tempClankHouse()
    const key = fs.readFileSync(path.join(fixtures, "localhost-key.pem"))
    const cert = fs.readFileSync(path.join(fixtures, "localhost-cert.pem"))

    // when binding publicly without TLS
    // then startup is rejected before listening
    await expect(listen(clankhouse, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/TLS is required/)

    // when binding publicly with a valid certificate
    const server = await listen(clankhouse, { host: "0.0.0.0", port: 0, tls: { key, cert } })
    onTestFinished(() => server.close())
    const client = rpcClient({ ...server, url: `https://127.0.0.1:${server.port}` }, server.apiKey, { ca: cert })

    // then a real authenticated HTTPS request succeeds
    expect(await client.listWorkflows({})).toMatchObject({ workflows: [] })
})

test("closing a server rejects active streams without closing ClankHouse", async () => {
    // given a live run, session, artifact and active Connect streams
    const { clankhouse } = tempClankHouse()
    clankhouse.registerWorkflow(
        "waiting",
        { input: z.null(), output: z.number(), key: () => "waiting" },
        async () => (await clankhouse.waitFor({ key: "never", schema: z.object({ value: z.number() }) })).value
    )
    const recorder = await testSession(clankhouse, {
        kind: "llm",
        client: "fake-llm",
        provider: "fake",
        model: "fake"
    })
    recorder.addMessage("assistant", "working")
    let artifactCanceled = false
    clankhouse.artifacts.read = async () => ({
        stream: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1]))
            },
            cancel() {
                artifactCanceled = true
            }
        })
    })
    const server = await listen(clankhouse, { port: 0 })
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

    // then every stream reports shutdown and the supplied ClankHouse database remains open
    expect(outcomes).toHaveLength(3)
    for (const outcome of outcomes) {
        expect(outcome).toBeInstanceOf(ConnectError)
        expect(outcome).toMatchObject({ code: Code.Unavailable })
    }
    expect(artifactCanceled).toBe(true)
    expect((await clankhouse.runs.get(started.runId)).status).toBe("running")
    expect((await clankhouse.sessions.get(recorder.id)).status).toBe("running")
})
