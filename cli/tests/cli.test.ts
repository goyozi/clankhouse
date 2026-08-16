import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { PassThrough, Readable, Writable } from "node:stream"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { fromJsonString } from "@bufbuild/protobuf"
import { FakeCodingAgent } from "@loopy/core/ai/fake-agent"
import { FakeLLM } from "@loopy/core/ai/fake-llm"
import { openDatabase } from "@loopy/core/db"
import { LoopyError } from "@loopy/core/errors"
import { GitRepository } from "@loopy/core/git"
import type { Loopy } from "@loopy/core/loopy"
import {
    ExecutionStatus,
    GetArtifactResponseSchema,
    GetRunResponseSchema,
    GetSessionResponseSchema,
    ListRunsResponseSchema,
    ListWorkflowsResponseSchema,
    ReadArtifactResponseSchema,
    RerunRunResponseSchema,
    ResumeRunResponseSchema,
    StartRunResponseSchema,
    WatchRunResponseSchema,
    WatchSessionResponseSchema
} from "@loopy/server/proto"
import { listen, type LoopyServer } from "@loopy/server"
import { gate, runOutput, tempDir, tempGitRepo, tempLoopy, testRun, waitForRun } from "@loopy/test-utils"
import { expect, onTestFinished, test } from "vitest"
import * as z from "zod"
import { runCli } from "../src"

const execFileAsync = promisify(execFile)
const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

type CliExecution = {
    done: Promise<number>
    stdout: () => Buffer
    stderr: () => string
}

function startCli(
    args: string[],
    options: {
        env: NodeJS.ProcessEnv
        cwd?: string
        input?: string
        stdin?: NodeJS.ReadableStream
        signal?: AbortSignal
    }
): CliExecution {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    stdout.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)))
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
    const done = runCli(args, {
        stdin: options.stdin ?? Readable.from(options.input === undefined ? [] : [options.input]),
        stdout,
        stderr,
        env: options.env,
        cwd: options.cwd ?? process.cwd(),
        ...(options.signal !== undefined ? { signal: options.signal } : {})
    })
    return {
        done,
        stdout: () => Buffer.concat(stdoutChunks),
        stderr: () => Buffer.concat(stderrChunks).toString("utf8")
    }
}

async function runCliCommand(
    args: string[],
    options: {
        env: NodeJS.ProcessEnv
        cwd?: string
        input?: string
        stdin?: NodeJS.ReadableStream
        signal?: AbortSignal
    }
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    const execution = startCli(args, options)
    const code = await execution.done
    return { code, stdout: execution.stdout(), stderr: execution.stderr() }
}

function serverEnv(server: LoopyServer): NodeJS.ProcessEnv {
    return {
        ...process.env,
        LOOPY_SERVER_URL: server.url,
        LOOPY_API_KEY: server.apiKey
    }
}

async function testServer(loopy: Loopy): Promise<LoopyServer> {
    const server = await listen(loopy, { port: 0 })
    onTestFinished(() => server.close())
    return server
}

const maxPollAttempts = 2000

async function waitForStep(loopy: Loopy, runId: string, key: string) {
    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        const run = await loopy.runs.get(runId)
        const step = run.steps.find((candidate) => candidate.key === key)
        if (step !== undefined) return step
        await delay(5)
    }
    throw new Error(`Step did not appear: ${key}`)
}

async function waitForOutput(execution: CliExecution, text: string): Promise<void> {
    await waitForCondition(
        () => execution.stdout().toString("utf8").includes(text),
        `CLI output did not contain: ${text}`
    )
}

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        if (condition()) return
        await delay(5)
    }
    throw new Error(message)
}

function lines(output: Buffer): string[] {
    return output
        .toString("utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function gatedOutput(predicate: (chunk: Buffer) => boolean): {
    stream: Writable
    blocked: Promise<void>
    release: () => void
    output: () => Buffer
} {
    const blocked = gate()
    const continuation = gate()
    const chunks: Buffer[] = []
    let waiting = false
    const stream = new Writable({
        highWaterMark: 1,
        write(chunk: Buffer, _encoding, callback) {
            const copy = Buffer.from(chunk)
            chunks.push(copy)
            if (!waiting && predicate(copy)) {
                waiting = true
                blocked.release()
                void continuation.released.then(() => callback())
                return
            }
            callback()
        }
    })
    onTestFinished(continuation.release)
    return {
        stream,
        blocked: blocked.released,
        release: continuation.release,
        output: () => Buffer.concat(chunks)
    }
}

test("drives FakeLLM and FakeCodingAgent workflows through the complete CLI surface", async () => {
    // given a real server with a fake-provider workflow, Git repository, and event gate
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
                artifactId: z.string(),
                approved: z.boolean(),
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
            return {
                summary: plan.summary,
                artifactId: artifact.id,
                approved: approval.ok,
                published: result
            }
        }
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const cwd = tempDir("loopy-cli-")
    fs.writeFileSync(path.join(cwd, "input.json"), JSON.stringify({ id: "feature-1", topic: "cli" }))

    // when workflows are discovered and a run is started from a real input file
    const workflowList = await runCliCommand(["workflows", "list", "--json"], { env, cwd })
    const listed = fromJsonString(ListWorkflowsResponseSchema, lines(workflowList.stdout)[0]!)
    const workflowHuman = await runCliCommand(["workflows", "get", "build"], { env, cwd })
    const startedResult = await runCliCommand(["runs", "start", "build", "--input", "input.json", "--json"], {
        env,
        cwd
    })
    const started = fromJsonString(StartRunResponseSchema, lines(startedResult.stdout)[0]!)
    const waiting = await waitForStep(loopy, started.runId, "wait:approval:feature-1")

    // then discovery, filtering, snapshots, sessions, and artifacts use strict ProtoJSON
    expect(workflowList.code).toBe(0)
    expect(listed.workflows.map((workflow) => workflow.name)).toEqual(["build"])
    expect(workflowHuman.stdout.toString()).toContain("Workflow: build")
    expect(workflowHuman.stdout.toString()).toContain("Input schema:\n  {")
    expect(startedResult.code).toBe(0)
    const runList = await runCliCommand(
        ["runs", "list", "--workflow", "build", "--key", "feature-1", "--status", "running", "--limit", "1", "--json"],
        { env }
    )
    expect(fromJsonString(ListRunsResponseSchema, lines(runList.stdout)[0]!).runs).toMatchObject([
        { id: started.runId, status: ExecutionStatus.RUNNING }
    ])
    const snapshotResult = await runCliCommand(["runs", "get", started.runId, "--include", "sessions", "--json"], {
        env
    })
    const snapshotLines = lines(snapshotResult.stdout)
    const snapshot = fromJsonString(GetRunResponseSchema, snapshotLines[0]!)
    const sessionResponses = snapshotLines.slice(1).map((line) => fromJsonString(GetSessionResponseSchema, line))
    expect(snapshot.run?.steps.map((step) => step.sessionId).filter(Boolean)).toHaveLength(2)
    expect(sessionResponses).toHaveLength(2)
    const session = sessionResponses[0]!.session!
    expect(session).toMatchObject({ client: "fake-llm", provider: "fake", model: "fake" })
    const sessionHuman = await runCliCommand(["sessions", "get", session.id], { env })
    const sessionHumanOutput = sessionHuman.stdout.toString()
    expect(sessionHumanOutput).toContain("Kind: llm\nClient: fake-llm\nProvider: fake\nModel: fake")
    expect(sessionHumanOutput).toContain("user: cli")
    expect(sessionHumanOutput).toContain('assistant: {"summary":"summary:cli"}')
    const sessionWatch = await runCliCommand(["sessions", "watch", session.id, "--json"], { env })
    expect(
        lines(sessionWatch.stdout).map((line) => fromJsonString(WatchSessionResponseSchema, line).message?.id)
    ).toEqual(session.messages.map((message) => message.id))
    const artifactId = snapshot.run!.artifacts[0]!.id
    const artifact = await runCliCommand(["artifacts", "get", artifactId, "--json"], { env })
    expect({ code: artifact.code, stderr: artifact.stderr }).toEqual({ code: 0, stderr: "" })
    expect(fromJsonString(GetArtifactResponseSchema, lines(artifact.stdout)[0]!).artifact).toMatchObject({
        id: artifactId,
        mimeType: "text/plain"
    })
    const readJson = await runCliCommand(["artifacts", "read", artifactId, "--json"], { env })
    const artifactBytes = Buffer.concat(
        lines(readJson.stdout).map((line) => fromJsonString(ReadArtifactResponseSchema, line).chunk)
    )
    expect(artifactBytes.toString()).toBe("summary:cli")
    const raw = await runCliCommand(["artifacts", "read", artifactId], { env })
    expect(raw.stdout.toString()).toBe("summary:cli")
    const copied = await runCliCommand(["artifacts", "copy", artifactId, "summary.txt", "--json"], { env, cwd })
    expect(fromJsonString(GetArtifactResponseSchema, lines(copied.stdout)[0]!).artifact?.id).toBe(artifactId)
    expect(fs.readFileSync(path.join(cwd, "summary.txt"), "utf8")).toBe("summary:cli")
    const noClobber = await runCliCommand(["artifacts", "copy", artifactId, "summary.txt", "--json"], { env, cwd })
    expect(noClobber.code).toBe(1)
    expect(JSON.parse(noClobber.stderr)).toMatchObject({ type: "error", code: "already_exists" })

    // when the run and its sessions are watched and the gate is opened through the CLI
    const watch = startCli(["runs", "watch", started.runId, "--include", "sessions", "--json"], { env })
    await waitForOutput(watch, waiting.id)
    const emitted = await runCliCommand(["events", "emit", "approval:feature-1", "--input", "-", "--json"], {
        env,
        input: JSON.stringify({ ok: true })
    })
    const watchCode = await watch.done
    const watchLines = lines(watch.stdout())

    // then run and session responses remain unwrapped, the run succeeds, and rerun replays fake providers
    expect(emitted.stdout.toString()).toBe("{}\n")
    expect(watchCode).toBe(0)
    expect(
        watchLines.some((line) => {
            const value = JSON.parse(line) as Record<string, unknown>
            return "message" in value
        })
    ).toBe(true)
    const runUpdates = watchLines
        .filter((line) => !("message" in (JSON.parse(line) as Record<string, unknown>)))
        .map((line) => fromJsonString(WatchRunResponseSchema, line))
    expect(runUpdates.at(-1)?.item).toMatchObject({
        case: "run",
        value: { status: ExecutionStatus.SUCCEEDED }
    })
    published = "v2"
    const rerunResult = await runCliCommand(["runs", "rerun", started.runId, "--from", "publish", "--json"], {
        env
    })
    const rerun = fromJsonString(RerunRunResponseSchema, lines(rerunResult.stdout)[0]!)
    const rerunWatch = await runCliCommand(["runs", "watch", rerun.runId, "--json"], { env })
    expect(rerunWatch.code).toBe(0)
    expect(await loopy.runs.get(rerun.runId)).toMatchObject({ attempt: 2, output: { published: "v2" } })
    expect({ llmCalls, agentCalls }).toEqual({ llmCalls: 1, agentCalls: 1 })
})

test("renders failed session tool results with their status and error", async () => {
    // given a completed session with a failed tool result that has no output
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({
        kind: "coding-agent",
        client: "fake-agent",
        provider: "fake",
        model: "fake"
    })
    recorder.addToolCall({
        id: "call-1",
        name: "lookup",
        source: { kind: "mcp", server: "docs" },
        input: { query: "sessions" }
    })
    recorder.addToolResult({ toolCallId: "call-1", status: "failed", error: "unavailable" })
    recorder.succeed()
    const server = await testServer(loopy)

    // when the session is printed in human-readable form
    const result = await runCliCommand(["sessions", "get", recorder.id], { env: serverEnv(server) })

    // then the failed status and diagnostic are visible
    expect(result.code).toBe(0)
    expect(result.stdout.toString()).toContain(
        'tool_result: {"toolUseId":"call-1","status":"failed","content":null,"error":"unavailable"}'
    )
})

test("starts void-input workflows without an input file", async () => {
    // given workflows with void and required inputs
    const { loopy } = tempLoopy()
    loopy.registerWorkflow(
        "void-input",
        { input: z.void(), output: z.string(), key: () => "void-input" },
        async () => "done"
    )
    loopy.registerWorkflow(
        "required-input",
        { input: z.string(), output: z.void(), key: (input) => input },
        async () => undefined
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)

    // when both workflows are inspected and started without --input
    const workflow = await runCliCommand(["workflows", "get", "void-input"], { env })
    const voidOutputWorkflow = await runCliCommand(["workflows", "get", "required-input"], { env })
    const startedResult = await runCliCommand(["runs", "start", "void-input", "--json"], { env })
    const started = fromJsonString(StartRunResponseSchema, lines(startedResult.stdout)[0]!)
    const output = await runOutput(loopy, started.runId)
    const rejected = await runCliCommand(["runs", "start", "required-input", "--json"], { env })

    // then the void workflow advertises and accepts absent input
    expect(workflow.stdout.toString()).toContain("Input: none")
    expect(startedResult.code).toBe(0)
    expect(output).toBe("done")
    // and an absent output schema is reported the same way as an absent input schema
    expect(voidOutputWorkflow.stdout.toString()).toContain("Output: none")
    // and a normal workflow rejects absent input with the reason the schema gave
    expect(rejected.code).toBe(1)
    expect(JSON.parse(rejected.stderr)).toMatchObject({
        type: "error",
        code: "invalid_argument",
        message: "Workflow input is invalid: Invalid input: expected string, received undefined"
    })
})

test("runs workflows with pipeline-safe output and reconnects to keyed runs", async () => {
    // given a workflow with separate running and immediately available inputs
    const { loopy } = tempLoopy()
    const pipeBlocker = gate()
    const fileBlocker = gate()
    onTestFinished(() => {
        pipeBlocker.release()
        fileBlocker.release()
    })
    const blockers = new Map([
        ["pipe", pipeBlocker],
        ["file", fileBlocker]
    ])
    let invocations = 0
    loopy.registerWorkflow(
        "pipeline-run",
        {
            input: z.object({ id: z.string(), value: z.number() }),
            output: z.object({ id: z.string(), doubled: z.number() }),
            key: (input) => input.id
        },
        async (input) => {
            invocations++
            const blocker = blockers.get(input.id)
            if (blocker === undefined) throw new Error(`Missing blocker: ${input.id}`)
            await loopy.step("wait", z.void(), async () => blocker.released)
            return { id: input.id, doubled: input.value * 2 }
        }
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const cwd = tempDir("loopy-cli-run-")
    const pipeInput = { id: "pipe", value: 4 }
    const runningId = loopy.start("pipeline-run", pipeInput)
    await waitForStep(loopy, runningId, "wait")

    // when the command receives piped input for an existing run and that run completes
    const running = startCli(["run", "pipeline-run", "--input", "-"], {
        env,
        input: JSON.stringify(pipeInput)
    })
    expect(running.stdout().toString()).toBe("")
    pipeBlocker.release()
    const runningCode = await running.done
    const succeeded = await runCliCommand(["run", "pipeline-run", "--input", "-"], {
        env,
        input: JSON.stringify(pipeInput)
    })

    // then both invocations emit only the stored output and execute the keyed run once
    const pipeOutput = `${JSON.stringify({ id: "pipe", doubled: 8 })}\n`
    expect({ code: runningCode, stdout: running.stdout().toString(), stderr: running.stderr() }).toEqual({
        code: 0,
        stdout: pipeOutput,
        stderr: ""
    })
    expect({ code: succeeded.code, stdout: succeeded.stdout.toString(), stderr: succeeded.stderr }).toEqual({
        code: 0,
        stdout: pipeOutput,
        stderr: ""
    })
    expect(invocations).toBe(1)

    // and when a new input is supplied from a file
    const fileInput = { id: "file", value: 5 }
    fs.writeFileSync(path.join(cwd, "input.json"), JSON.stringify(fileInput))
    fileBlocker.release()
    const fromFile = await runCliCommand(["run", "pipeline-run", "--input", "input.json"], { env, cwd })

    // then the command starts it and emits its final JSON output without an envelope
    expect({ code: fromFile.code, stdout: fromFile.stdout.toString(), stderr: fromFile.stderr }).toEqual({
        code: 0,
        stdout: `${JSON.stringify({ id: "file", doubled: 10 })}\n`,
        stderr: ""
    })
    expect(invocations).toBe(2)
})

test("runs void workflows without input or output", async () => {
    // given a workflow with void input and output
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("void-run", { input: z.void(), output: z.void(), key: () => "void-run" }, async () => {})
    const server = await testServer(loopy)

    // when it is run without an input option
    const result = await runCliCommand(["run", "void-run"], { env: serverEnv(server) })

    // then it succeeds without writing a JSON placeholder
    expect({ code: result.code, stdout: result.stdout.toString(), stderr: result.stderr }).toEqual({
        code: 0,
        stdout: "",
        stderr: ""
    })
})

test("reports workflow failures without contaminating pipeline output", async () => {
    // given workflows that fail with coded and ordinary errors
    const { loopy } = tempLoopy()
    loopy.registerWorkflow(
        "coded-run-error",
        { input: z.void(), output: z.void(), key: () => "coded-run-error" },
        async () =>
            loopy.step("fail", z.void(), async () => {
                throw new LoopyError("event_sources_empty", "coded failure")
            })
    )
    loopy.registerWorkflow(
        "ordinary-run-error",
        { input: z.string(), output: z.void(), key: (input) => input },
        async () =>
            loopy.step("fail", z.void(), async () => {
                throw new Error("ordinary failure")
            })
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)

    // when coded and ordinary failures are requested in JSON and human-readable modes
    const coded = await runCliCommand(["run", "coded-run-error", "--json"], { env })
    const ordinaryHuman = await runCliCommand(["run", "ordinary-run-error", "--input", "-"], {
        env,
        input: JSON.stringify("human")
    })
    const ordinaryJson = await runCliCommand(["run", "ordinary-run-error", "--input", "-", "--json"], {
        env,
        input: JSON.stringify("json")
    })

    // then stdout stays empty and persisted or fallback codes are reported on stderr
    expect({ code: coded.code, stdout: coded.stdout.toString(), error: JSON.parse(coded.stderr) }).toEqual({
        code: 1,
        stdout: "",
        error: { type: "error", code: "event_sources_empty", message: "coded failure" }
    })
    expect({ code: ordinaryHuman.code, stdout: ordinaryHuman.stdout.toString(), stderr: ordinaryHuman.stderr }).toEqual(
        {
            code: 1,
            stdout: "",
            stderr: "loopy: ordinary failure\n"
        }
    )
    expect({
        code: ordinaryJson.code,
        stdout: ordinaryJson.stdout.toString(),
        error: JSON.parse(ordinaryJson.stderr)
    }).toEqual({
        code: 1,
        stdout: "",
        error: { type: "error", code: "workflow_run_failed", message: "ordinary failure" }
    })
})

test("cancels a running workflow command without reporting an error", async () => {
    // given a workflow command waiting for its run to finish
    const { loopy } = tempLoopy()
    const entered = gate()
    const parked = gate()
    onTestFinished(() => {
        entered.release()
        parked.release()
    })
    loopy.registerWorkflow("cancel-run", { input: z.void(), output: z.string(), key: () => "cancel-run" }, async () => {
        await loopy.step("park", z.void(), async () => {
            entered.release()
            await parked.released
        })
        return "finished"
    })
    const server = await testServer(loopy)
    const controller = new AbortController()
    const command = startCli(["run", "cancel-run"], {
        env: serverEnv(server),
        signal: controller.signal
    })
    await entered.released

    // when the command is canceled while its workflow remains active
    controller.abort(new DOMException("Interrupted", "AbortError"))
    const code = await command.done

    // then it returns the shell cancellation status with clean output streams
    expect({ code, stdout: command.stdout().toString(), stderr: command.stderr() }).toEqual({
        code: 130,
        stdout: "",
        stderr: ""
    })

    // and the observer cancellation does not cancel the underlying workflow
    parked.release()
    const [run] = await loopy.runs.list({ key: "cancel-run" })
    expect(await waitForRun(loopy, run!.id)).toMatchObject({ status: "succeeded", output: "finished" })
})

test("get --watch prints snapshots around live updates without duplicating included session history", async () => {
    // given a real server with a run waiting after a completed FakeLLM session
    const { loopy } = tempLoopy()
    const llm = new FakeLLM((_stepName, prompt) => ({ reply: prompt }))
    loopy.registerWorkflow(
        "approval",
        { input: z.object({ id: z.string() }), output: z.string(), key: (input) => input.id },
        async (input) => {
            await llm.call("prepare", { prompt: input.id, output: z.object({ reply: z.string() }) })
            const event = await loopy.waitFor({
                key: `get-watch:${input.id}`,
                schema: z.object({ value: z.string() })
            })
            return event.value
        }
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const startedResult = await runCliCommand(["runs", "start", "approval", "--input", "-", "--json"], {
        env,
        input: JSON.stringify({ id: "item-1" })
    })
    const runId = fromJsonString(StartRunResponseSchema, lines(startedResult.stdout)[0]!).runId
    const waiting = await waitForStep(loopy, runId, "wait:get-watch:item-1")

    // when snapshot-then-tail watching starts and an event completes the run
    const watch = startCli(["runs", "get", runId, "--include", "sessions", "--watch", "--json"], { env })
    await waitForOutput(watch, waiting.id)
    await runCliCommand(["events", "emit", "get-watch:item-1", "--input", "-", "--json"], {
        env,
        input: JSON.stringify({ value: "approved" })
    })
    const code = await watch.done
    const outputLines = lines(watch.stdout())
    const runSnapshots = outputLines
        .filter((line) => "run" in (JSON.parse(line) as Record<string, unknown>) && "metadata" in JSON.parse(line).run)
        .map((line) => fromJsonString(GetRunResponseSchema, line))
    const sessionMessages = outputLines.filter((line) => "message" in (JSON.parse(line) as Record<string, unknown>))
    const sessionSnapshots = outputLines.filter((line) => "session" in (JSON.parse(line) as Record<string, unknown>))

    // then initial and final GetRun responses surround updates and persisted messages are not streamed again
    expect(code).toBe(0)
    expect(runSnapshots).toHaveLength(2)
    expect(runSnapshots[0]!.run?.metadata?.status).toBe(ExecutionStatus.RUNNING)
    expect(runSnapshots[1]!.run?.metadata?.status).toBe(ExecutionStatus.SUCCEEDED)
    expect(runSnapshots[1]!.run?.outputJson).toBe(JSON.stringify("approved"))
    expect(sessionMessages).toEqual([])

    // and only the initial snapshot carries session history: the final "run finished" snapshot omits it
    expect(sessionSnapshots).toHaveLength(1)
})

test("get --watch observes concurrent steps that complete out of sequence order", async () => {
    // given a real server with two concurrently running workflow steps
    const { loopy } = tempLoopy()
    const first = gate()
    const second = gate()
    onTestFinished(() => {
        first.release()
        second.release()
    })
    loopy.registerWorkflow(
        "parallel-watch",
        { input: z.null(), output: z.void(), key: () => "parallel-watch" },
        async () => {
            await Promise.all([
                loopy.step("first", z.string(), async () => {
                    await first.released
                    return "first"
                }),
                loopy.step("second", z.string(), async () => {
                    await second.released
                    return "second"
                })
            ])
        }
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const startedResult = await runCliCommand(["runs", "start", "parallel-watch", "--input", "-", "--json"], {
        env,
        input: "null"
    })
    const runId = fromJsonString(StartRunResponseSchema, lines(startedResult.stdout)[0]!).runId
    const firstStep = await waitForStep(loopy, runId, "first")
    const secondStep = await waitForStep(loopy, runId, "second")

    // when snapshot-then-tail watching starts and the later step completes first
    const watch = startCli(["runs", "get", runId, "--watch", "--json"], { env })
    await waitForOutput(watch, secondStep.id)
    second.release()
    await waitForCondition(
        () =>
            lines(watch.stdout()).some((line) => {
                const value = JSON.parse(line) as Record<string, unknown>
                if (!("step" in value)) return false
                const update = fromJsonString(WatchRunResponseSchema, line)
                return (
                    update.item.case === "step" &&
                    update.item.value.id === secondStep.id &&
                    update.item.value.status === ExecutionStatus.SUCCEEDED
                )
            }),
        "CLI did not observe the later concurrent step completing"
    )
    first.release()
    const code = await watch.done
    const stepUpdates = lines(watch.stdout())
        .filter((line) => "step" in (JSON.parse(line) as Record<string, unknown>))
        .map((line) => fromJsonString(WatchRunResponseSchema, line).item)

    // then both terminal step transitions are emitted before the watch succeeds
    expect(code).toBe(0)
    expect(stepUpdates).toEqual(
        expect.arrayContaining([
            { case: "step", value: expect.objectContaining({ id: firstStep.id, status: ExecutionStatus.SUCCEEDED }) },
            { case: "step", value: expect.objectContaining({ id: secondStep.id, status: ExecutionStatus.SUCCEEDED }) }
        ])
    )
})

test("human run watch does not repeat a step when only hidden metadata changes", async () => {
    // given a watched workflow that parks before attaching a session to an agent step
    const { loopy } = tempLoopy()
    const ready = gate()
    const attachSession = gate()
    const parked = gate()
    onTestFinished(() => {
        ready.release()
        attachSession.release()
        parked.release()
    })
    loopy.registerWorkflow(
        "human-agent-watch",
        { input: z.null(), output: z.void(), key: () => "human-agent-watch" },
        async () => {
            await loopy.step("ready", z.void(), async () => ready.released)
            await loopy.engine.executeStep({
                kind: "agent",
                name: "plan",
                schema: z.object({ done: z.boolean() }),
                execute: async (handle) => {
                    await attachSession.released
                    const session = loopy.sessions.create({
                        kind: "coding-agent",
                        client: "parking-agent",
                        provider: "parking",
                        model: "parking"
                    })
                    handle.set("session_id", session.id)
                    session.addMessage("user", "plan")
                    await parked.released
                    session.succeed()
                    return { done: true }
                }
            })
        }
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const runId = loopy.start("human-agent-watch", null)
    await waitForStep(loopy, runId, "ready")

    // when watching starts before the agent gains its session metadata
    const watch = startCli(["runs", "watch", runId, "--include", "sessions"], { env })
    await waitForOutput(watch, "1. ready")
    ready.release()
    await waitForOutput(watch, "2. plan")
    attachSession.release()
    await waitForOutput(watch, "user       plan")
    parked.release()
    const code = await watch.done
    const planUpdates = lines(watch.stdout())
        .map((line) => line.trim())
        .filter((line) => line.startsWith("coding-agent ·"))

    // then the human output reports each visible agent state once
    expect(code).toBe(0)
    expect(planUpdates).toHaveLength(2)
    expect(planUpdates[0]).toBe("coding-agent · running")
    expect(planUpdates[1]).toMatch(/^coding-agent · succeeded · /)
})

test("human get --watch does not repeat a snapshotted step when only hidden metadata changes", async () => {
    // given an agent step parked before attaching its session metadata
    const { loopy } = tempLoopy()
    const entered = gate()
    const attachSession = gate()
    const parked = gate()
    onTestFinished(() => {
        entered.release()
        attachSession.release()
        parked.release()
    })
    loopy.registerWorkflow(
        "human-agent-get-watch",
        { input: z.null(), output: z.void(), key: () => "human-agent-get-watch" },
        async () => {
            await loopy.engine.executeStep({
                kind: "agent",
                name: "plan",
                schema: z.object({ done: z.boolean() }),
                execute: async (handle) => {
                    entered.release()
                    await attachSession.released
                    const session = loopy.sessions.create({
                        kind: "coding-agent",
                        client: "parking-agent",
                        provider: "parking",
                        model: "parking"
                    })
                    handle.set("session_id", session.id)
                    session.addMessage("user", "plan")
                    await parked.released
                    session.succeed()
                    return { done: true }
                }
            })
        }
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const runId = loopy.start("human-agent-get-watch", null)
    await entered.released
    const plan = await waitForStep(loopy, runId, "plan")

    // when snapshot-then-tail watching starts before the session is attached
    const watch = startCli(["runs", "get", runId, "--include", "sessions", "--watch"], { env })
    await waitForOutput(watch, `  ${plan.seq + 1}. ${plan.key}`)
    attachSession.release()
    await waitForOutput(watch, "user       plan")
    parked.release()
    const code = await watch.done
    const updates = watch.stdout().toString("utf8").split("\nUpdates\n")[1] ?? ""
    const planUpdates = updates
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("coding-agent ·"))

    // then the snapshot's visible running state is not repeated by the metadata-only update
    expect(code).toBe(0)
    expect(planUpdates).toHaveLength(1)
    expect(planUpdates[0]).toMatch(/^coding-agent · succeeded · /)
})

test("included session failures do not stop the primary run watch", async () => {
    // given a live run whose completed session cursor becomes invalid after its initial snapshot
    const { loopy, dir } = tempLoopy()
    const llm = new FakeLLM((_stepName, prompt) => ({ reply: prompt }))
    loopy.registerWorkflow(
        "session-watch-error",
        { input: z.null(), output: z.string(), key: () => "session-watch-error" },
        async () => {
            await llm.call("prepare", { prompt: "watch", output: z.object({ reply: z.string() }) })
            return (await loopy.waitFor({ key: "session-watch-done", schema: z.object({ value: z.string() }) })).value
        }
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const startedResult = await runCliCommand(["runs", "start", "session-watch-error", "--input", "-", "--json"], {
        env,
        input: "null"
    })
    const runId = fromJsonString(StartRunResponseSchema, lines(startedResult.stdout)[0]!).runId
    await waitForStep(loopy, runId, "wait:session-watch-done")
    const run = await loopy.runs.get(runId)
    const sessionIds = run.steps.flatMap((step) =>
        "sessionId" in step && step.sessionId !== undefined ? [step.sessionId] : []
    )
    const sessionId = sessionIds[0]!
    const session = await loopy.sessions.get(sessionId)
    const cursor = session.messages.at(-1)!.id
    const stdout = gatedOutput((chunk) => "session" in (JSON.parse(chunk.toString("utf8")) as Record<string, unknown>))
    const stderr = new PassThrough()
    const stderrChunks: Buffer[] = []
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
    const done = runCli(["runs", "get", runId, "--include", "sessions", "--watch", "--json"], {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr,
        env
    })
    await stdout.blocked

    // when the persisted cursor is removed before tailing begins
    const db = openDatabase(path.join(dir, "loopy.db"))
    try {
        db.prepare("DELETE FROM session_messages WHERE id = ?").run(cursor)
    } finally {
        db.close()
    }
    stdout.release()
    await waitForCondition(
        () => Buffer.concat(stderrChunks).toString("utf8").includes('"scope":"session"'),
        "CLI did not report the included session failure"
    )
    await runCliCommand(["events", "emit", "session-watch-done", "--input", "-", "--json"], {
        env,
        input: JSON.stringify({ value: "complete" })
    })
    const code = await done
    const error = JSON.parse(Buffer.concat(stderrChunks).toString("utf8"))
    const runUpdates = lines(stdout.output())
        .filter((line) => {
            const value = JSON.parse(line) as { run?: Record<string, unknown> }
            return value.run !== undefined && !("metadata" in value.run)
        })
        .map((line) => fromJsonString(WatchRunResponseSchema, line))

    // then the scoped error is preserved while the primary watch reaches successful completion
    expect(code).toBe(1)
    expect(error).toMatchObject({ type: "error", code: "invalid_argument", scope: "session", sessionId })
    expect(runUpdates.at(-1)?.item).toMatchObject({
        case: "run",
        value: { id: runId, status: ExecutionStatus.SUCCEEDED }
    })
})

test("resume reconnects to an interrupted run and prints only its run ID", async () => {
    // given a run interrupted by closing its first real server
    const { loopy, reopen } = tempLoopy()
    const register = (instance: Loopy) =>
        instance.registerWorkflow(
            "resume",
            { input: z.null(), output: z.number(), key: () => "resume" },
            async () => (await instance.waitFor({ key: "resume-event", schema: z.object({ value: z.number() }) })).value
        )
    register(loopy)
    const firstServer = await listen(loopy, { port: 0 })
    const firstEnv = serverEnv(firstServer)
    const startedResult = await runCliCommand(["runs", "start", "resume", "--input", "-", "--json"], {
        env: firstEnv,
        input: "null"
    })
    const runId = fromJsonString(StartRunResponseSchema, lines(startedResult.stdout)[0]!).runId
    await waitForStep(loopy, runId, "wait:resume-event")
    await firstServer.close()
    const second = reopen()
    register(second)
    const secondServer = await testServer(second)
    const secondEnv = serverEnv(secondServer)

    // when the run is resumed and watched using the replacement server
    const resumed = await runCliCommand(["runs", "resume", runId, "--json"], { env: secondEnv })
    const watch = startCli(["runs", "watch", runId, "--json"], { env: secondEnv })
    await waitForOutput(watch, "resume-event")
    await runCliCommand(["events", "emit", "resume-event", "--input", "-", "--json"], {
        env: secondEnv,
        input: JSON.stringify({ value: 7 })
    })
    const watchCode = await watch.done

    // then resume emits only ResumeRunResponse ProtoJSON and the same run succeeds
    expect(fromJsonString(ResumeRunResponseSchema, lines(resumed.stdout)[0]!).runId).toBe(runId)
    expect(lines(resumed.stdout)).toHaveLength(1)
    expect(watchCode).toBe(0)
    expect(await second.runs.get(runId)).toMatchObject({ status: "succeeded", output: 7 })
})

test("reports structured failures and reflects failed watched runs in the exit status", async () => {
    // given a real server with a workflow that fails
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("failure", { input: z.null(), output: z.void(), key: () => "failure" }, async () =>
        loopy.step("fail", z.void(), async () => {
            throw new Error("broken")
        })
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const startedResult = await runCliCommand(["runs", "start", "failure", "--input", "-", "--json"], {
        env,
        input: "null"
    })
    const runId = fromJsonString(StartRunResponseSchema, lines(startedResult.stdout)[0]!).runId
    await waitForRun(loopy, runId)

    // when the failed run is inspected and watched alongside usage, input, and authentication errors
    const get = await runCliCommand(["runs", "get", runId, "--json"], { env })
    const getWatch = await runCliCommand(["runs", "get", runId, "--watch", "--json"], { env })
    const watch = await runCliCommand(["runs", "watch", runId, "--json"], { env })
    const usage = await runCliCommand(["runs", "list", "--status", "unknown", "--json"], { env })
    const input = await runCliCommand(["events", "emit", "key", "--input", "-", "--json"], {
        env,
        input: "{"
    })
    const authentication = await runCliCommand(["workflows", "list", "--api-key", "wrong", "--json"], { env })
    const consumedJson = await runCliCommand(["--server", "--json", "workflows", "list"], { env })

    // then inspection succeeds, watches fail after valid ProtoJSON, and other failures stay on JSON stderr
    expect(get.code).toBe(0)
    expect(getWatch.code).toBe(1)
    expect(watch.code).toBe(1)
    expect(fromJsonString(GetRunResponseSchema, lines(getWatch.stdout)[0]!).run?.metadata?.status).toBe(
        ExecutionStatus.FAILED
    )
    expect(fromJsonString(WatchRunResponseSchema, lines(watch.stdout).at(-1)!).item).toMatchObject({
        case: "run",
        value: { status: ExecutionStatus.FAILED }
    })
    expect(usage.code).toBe(2)
    expect(JSON.parse(usage.stderr)).toMatchObject({ type: "error", code: "usage" })
    expect(input.code).toBe(1)
    expect(JSON.parse(input.stderr)).toMatchObject({ type: "error", code: "input" })
    expect(authentication.code).toBe(1)
    expect(JSON.parse(authentication.stderr)).toMatchObject({ type: "error", code: "unauthenticated" })
    expect(consumedJson.code).toBe(1)
    expect(consumedJson.stderr).toMatch(/^loopy: /)

    // and the executable bootstrap reaches the same authenticated server
    const executable = path.join(cliDir, "bin", "loopy.js")
    const child = await execFileAsync(
        process.execPath,
        [executable, "--server", server.url, "--api-key", server.apiKey, "--json", "workflows", "list"],
        { cwd: cliDir }
    )
    expect(fromJsonString(ListWorkflowsResponseSchema, child.stdout.trim()).workflows).toMatchObject([
        { name: "failure" }
    ])
})

test("reports server shutdown without publishing an incomplete artifact copy", async () => {
    // given a live run and an artifact stream that stalls after its first chunk
    const { loopy } = tempLoopy()
    const artifact = await testRun(loopy, async () => loopy.artifacts.writeText("report", "complete"))
    loopy.registerWorkflow(
        "shutdown",
        { input: z.null(), output: z.number(), key: () => "shutdown" },
        async () => (await loopy.waitFor({ key: "shutdown-event", schema: z.object({ value: z.number() }) })).value
    )
    const runId = loopy.start("shutdown", null)
    const waiting = await waitForStep(loopy, runId, "wait:shutdown-event")
    const sourceDemanded = gate()
    loopy.artifacts.read = async () => ({
        stream: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(Buffer.from("partial"))
            },
            pull() {
                sourceDemanded.release()
            }
        })
    })
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const cwd = tempDir("loopy-cli-shutdown-")
    const destination = path.join(cwd, "report.txt")

    // when shutdown interrupts a run watch and an artifact copy in progress
    const watch = startCli(["runs", "watch", runId, "--json"], { env })
    await waitForOutput(watch, waiting.id)
    const copy = startCli(["artifacts", "copy", artifact.id, destination, "--json"], { env, cwd })
    await sourceDemanded.released
    await server.close()
    const [watchCode, copyCode] = await Promise.all([watch.done, copy.done])

    // then both commands fail as unavailable and no partial destination or temporary file remains
    expect(watchCode).toBe(1)
    expect(JSON.parse(watch.stderr())).toMatchObject({ type: "error", code: "unavailable" })
    expect(copyCode).toBe(1)
    expect(JSON.parse(copy.stderr())).toMatchObject({ type: "error", code: "unavailable" })
    expect(fs.existsSync(destination)).toBe(false)
    expect(fs.readdirSync(cwd)).toEqual([])

    // and observing shutdown does not alter the running workflow
    expect((await loopy.runs.get(runId)).status).toBe("running")
})

test("treats a closed output pipe as successful early termination", async () => {
    // given a real server and an output stream whose downstream reader has closed
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("pipe", { input: z.null(), output: z.void(), key: () => "pipe" }, async () => {})
    const server = await testServer(loopy)
    const stderr = new PassThrough()
    const stderrChunks: Buffer[] = []
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
    const stdout = new Writable({
        write(_chunk, _encoding, callback) {
            const error = new Error("write EPIPE") as NodeJS.ErrnoException
            error.code = "EPIPE"
            callback(error)
        }
    })

    // when a command writes its response after the pipe closes
    const code = await runCli(["workflows", "list"], {
        stdin: Readable.from([]),
        stdout,
        stderr,
        env: serverEnv(server)
    })

    // then the command exits cleanly without reporting an internal error
    expect(code).toBe(0)
    expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("")
})

test("flushes Commander help output before resolving even when the writer is backpressured", async () => {
    // given a stdout stream that blocks on the first chunk of help output
    const stdout = gatedOutput((chunk) => chunk.toString("utf8").includes("Usage:"))
    const stderr = new PassThrough()
    const done = runCli(["--help"], { stdin: Readable.from([]), stdout: stdout.stream, stderr, env: {} })

    // when the help text has started writing but the consumer has not drained it
    await stdout.blocked
    const settled = await Promise.race([done.then(() => "resolved"), delay(50).then(() => "pending")])

    // then runCli stays pending until the blocked write drains
    expect(settled).toBe("pending")
    stdout.release()
    const code = await done

    // and the full help text reaches the stream with a clean exit
    expect(code).toBe(0)
    expect(stdout.output().toString("utf8")).toContain("Interact with a Loopy server")
})

test("resolves connection settings by flag, environment, and local credentials precedence", async () => {
    // given a real server whose credential is stored in its Loopy directory
    const { loopy, dir } = tempLoopy()
    loopy.registerWorkflow("configured", { input: z.null(), output: z.void(), key: () => "configured" }, async () => {})
    const server = await testServer(loopy)
    const credentialEnv: NodeJS.ProcessEnv = { ...process.env, LOOPY_SERVER_URL: server.url, LOOPY_DIR: dir }
    delete credentialEnv.LOOPY_API_KEY

    // when the CLI uses file credentials and explicit flags over incorrect environment values
    const fromFile = await runCliCommand(["workflows", "list", "--json"], { env: credentialEnv })
    const fromFlags = await runCliCommand(
        ["workflows", "list", "--server", server.url, "--api-key", server.apiKey, "--json"],
        {
            env: {
                ...process.env,
                LOOPY_SERVER_URL: "http://127.0.0.1:1",
                LOOPY_API_KEY: "wrong"
            }
        }
    )

    // then both authenticated requests succeed with strict response ProtoJSON
    expect(fromJsonString(ListWorkflowsResponseSchema, lines(fromFile.stdout)[0]!).workflows[0]?.name).toBe(
        "configured"
    )
    expect(fromJsonString(ListWorkflowsResponseSchema, lines(fromFlags.stdout)[0]!).workflows[0]?.name).toBe(
        "configured"
    )

    // and missing or malformed fallback credentials fail locally without exposing file contents
    const missingDir = tempDir("loopy-cli-missing-")
    const missing = await runCliCommand(["workflows", "list", "--json"], {
        env: { ...process.env, LOOPY_SERVER_URL: server.url, LOOPY_DIR: missingDir }
    })
    fs.writeFileSync(path.join(missingDir, "credentials.json"), "secret malformed contents")
    const malformed = await runCliCommand(["workflows", "list", "--json"], {
        env: { ...process.env, LOOPY_SERVER_URL: server.url, LOOPY_DIR: missingDir }
    })
    expect(missing.code).toBe(1)
    expect(JSON.parse(missing.stderr)).toMatchObject({ type: "error", code: "configuration" })
    expect(malformed.code).toBe(1)
    expect(JSON.parse(malformed.stderr)).toMatchObject({ type: "error", code: "configuration" })
    expect(malformed.stderr).not.toContain("secret malformed contents")
})

test("requires https for non-loopback servers and treats an empty server URL as unset", async () => {
    // given a server-authenticated environment and an equivalent one with no configured server URL
    const { loopy } = tempLoopy()
    loopy.registerWorkflow("policy", { input: z.null(), output: z.void(), key: () => "policy" }, async () => {})
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const unsetEnv = { ...env }
    delete unsetEnv.LOOPY_SERVER_URL

    // when plaintext http targets a remote host, and when the server URL is empty versus unset
    const insecure = await runCliCommand(["workflows", "list", "--server", "http://192.0.2.1:7331", "--json"], { env })
    const emptyUrl = await runCliCommand(["workflows", "list", "--json"], { env: { ...env, LOOPY_SERVER_URL: "" } })
    const unsetUrl = await runCliCommand(["workflows", "list", "--json"], { env: unsetEnv })

    // then remote plaintext is refused as a configuration error before any request is sent
    expect(insecure.code).toBe(1)
    expect(JSON.parse(insecure.stderr)).toMatchObject({ type: "error", code: "configuration" })
    expect(insecure.stderr).toContain("https")

    // and an empty URL is never a parse error but falls back to the loopback default, exactly like an unset URL
    expect(emptyUrl.stderr).not.toContain("Invalid Loopy server URL")
    expect(JSON.parse(emptyUrl.stderr).code).toBe(JSON.parse(unsetUrl.stderr).code)
})

test("cancels active watches with exit code 130 and no spurious error output", async () => {
    // given a real server with an active event-waiting run
    const { loopy } = tempLoopy()
    loopy.registerWorkflow(
        "cancel",
        { input: z.null(), output: z.number(), key: () => "cancel" },
        async () => (await loopy.waitFor({ key: "cancel-event", schema: z.object({ value: z.number() }) })).value
    )
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const startedResult = await runCliCommand(["runs", "start", "cancel", "--input", "-", "--json"], {
        env,
        input: "null"
    })
    const runId = fromJsonString(StartRunResponseSchema, lines(startedResult.stdout)[0]!).runId
    const waiting = await waitForStep(loopy, runId, "wait:cancel-event")
    const controller = new AbortController()

    // when a dedicated watch is aborted after receiving its current step
    const watch = startCli(["runs", "watch", runId, "--json"], { env, signal: controller.signal })
    await waitForOutput(watch, waiting.id)
    controller.abort(new DOMException("Interrupted", "AbortError"))
    const code = await watch.done

    // then the command reports interruption without treating cancellation as an RPC failure
    expect(code).toBe(130)
    expect(watch.stderr()).toBe("")

    // and the workflow remains usable after the observer disconnects
    await runCliCommand(["events", "emit", "cancel-event", "--input", "-", "--json"], {
        env,
        input: JSON.stringify({ value: 3 })
    })
    expect(await waitForRun(loopy, runId)).toMatchObject({ status: "succeeded", output: 3 })
})

test("cancels a command while it is reading JSON from stdin", async () => {
    // given a command waiting for JSON input from an open stdin stream
    const { loopy } = tempLoopy()
    const server = await testServer(loopy)
    const env = serverEnv(server)
    const stdin = new PassThrough()
    const controller = new AbortController()
    const command = startCli(["events", "emit", "never", "--input", "-", "--json"], {
        env,
        stdin,
        signal: controller.signal
    })
    await waitForCondition(() => stdin.listenerCount("data") > 0, "CLI did not start reading stdin")

    // when the command is aborted before stdin reaches EOF
    controller.abort(new DOMException("Interrupted", "AbortError"))
    const code = await command.done

    // then it exits as interrupted and releases all stdin listeners
    expect(code).toBe(130)
    expect(command.stderr()).toBe("")
    expect(stdin.listenerCount("data")).toBe(0)
    expect(stdin.listenerCount("end")).toBe(0)
    expect(stdin.listenerCount("error")).toBe(0)
})
