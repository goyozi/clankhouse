import { PassThrough, Readable } from "node:stream"
import { timestampFromDate } from "@bufbuild/protobuf/wkt"
import type { Loopy } from "@loopy/core/loopy"
import { listen, type LoopyServer } from "@loopy/server"
import { tempLoopy } from "@loopy/test-utils"
import { expect, onTestFinished, test } from "vitest"
import { runCli } from "../../../src"
import { executionTiming } from "../../../src/output"

async function testServer(loopy: Loopy): Promise<LoopyServer> {
    const server = await listen(loopy, { port: 0 })
    onTestFinished(() => server.close())
    return server
}

function serverEnv(server: LoopyServer): NodeJS.ProcessEnv {
    return {
        ...process.env,
        LOOPY_SERVER_URL: server.url,
        LOOPY_API_KEY: server.apiKey
    }
}

async function runCliCommand(
    args: string[],
    env: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    stdout.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)))
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
    const code = await runCli(args, {
        stdin: Readable.from([]),
        stdout,
        stderr,
        env,
        cwd: process.cwd()
    })
    return {
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
    }
}

function startCliCommand(
    args: string[],
    env: NodeJS.ProcessEnv
): {
    done: Promise<number>
    stdout: () => string
    stderr: () => string
} {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    stdout.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)))
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
    return {
        done: runCli(args, {
            stdin: Readable.from([]),
            stdout,
            stderr,
            env,
            cwd: process.cwd()
        }),
        stdout: () => Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: () => Buffer.concat(stderrChunks).toString("utf8")
    }
}

async function waitForOutput(output: () => string, text: string): Promise<void> {
    for (let attempt = 0; attempt < 2000; attempt++) {
        if (output().includes(text)) return
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`CLI output did not contain: ${text}\n\n${output()}`)
}

function duration(startedAt: Date, endedAt: Date | undefined): string {
    if (endedAt === undefined) throw new Error("Expected execution to have ended")
    const value = executionTiming(timestampFromDate(startedAt), timestampFromDate(endedAt))
    if (value === undefined) throw new Error("Expected execution timing")
    return value
}

function minute(date: Date): string {
    return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
}

function twoDigits(value: number): string {
    return String(value).padStart(2, "0")
}

test("sessions get command output matches designs", async () => {
    // given completed detailed and empty sessions
    const { loopy } = tempLoopy()
    const detailedRecorder = loopy.sessions.create({
        kind: "coding-agent",
        client: "fixture-agent",
        provider: "fixture-provider",
        model: "fixture-model"
    })
    detailedRecorder.addMessage("system", "Follow the review policy.\n")
    detailedRecorder.addMessage("user", "Review this\n\ncarefully")
    detailedRecorder.addMessage("assistant", "  Preserve this indentation.\nThen continue.")
    detailedRecorder.addToolCall({
        id: "call-1",
        name: "read",
        source: { kind: "native" },
        input: { path: "README.md" }
    })
    detailedRecorder.addToolResult({ toolCallId: "call-1", status: "succeeded", output: { lines: 2 } })
    detailedRecorder.addToolCall({
        id: "call-2",
        name: "lookup",
        source: { kind: "mcp", server: "docs" },
        input: { query: "sessions" }
    })
    detailedRecorder.addToolResult({ toolCallId: "call-2", status: "failed", error: "unavailable" })
    detailedRecorder.addMessage("reasoning", "The evidence is sufficient.")
    detailedRecorder.succeed()
    const emptyRecorder = loopy.sessions.create({
        kind: "llm",
        client: "fixture-llm",
        provider: "fixture-provider",
        model: "fixture-model"
    })
    emptyRecorder.succeed()
    const detailedSession = await loopy.sessions.get(detailedRecorder.id)
    const emptySession = await loopy.sessions.get(emptyRecorder.id)
    const env = serverEnv(await testServer(loopy))

    // when both sessions are requested in human-readable form
    const detailed = await runCliCommand(["sessions", "get", detailedRecorder.id], env)
    const empty = await runCliCommand(["sessions", "get", emptyRecorder.id], env)

    // then the detailed session uses the compact header and aligned multiline messages
    expect(detailed).toEqual({
        code: 0,
        stderr: "",
        stdout: `Session ${detailedRecorder.id}
  coding-agent · fixture-agent · fixture-provider/fixture-model
  succeeded · ${duration(detailedSession.startedAt, detailedSession.endedAt)}

Messages
  system     Follow the review policy.
  user       Review this

             carefully
  assistant    Preserve this indentation.
             Then continue.
  tool       {"id":"call-1","tool":"read","input":{"path":"README.md"}}
  result     {"toolUseId":"call-1","status":"succeeded","content":{"lines":2}}
  tool       {"id":"call-2","tool":"docs.lookup","input":{"query":"sessions"}}
  result     {"toolUseId":"call-2","status":"failed","content":null,"error":"unavailable"}
  reasoning  The evidence is sufficient.
`
    })

    // and the empty session shows an explicit message placeholder
    expect(empty).toEqual({
        code: 0,
        stderr: "",
        stdout: `Session ${emptyRecorder.id}
  llm · fixture-llm · fixture-provider/fixture-model
  succeeded · ${duration(emptySession.startedAt, emptySession.endedAt)}

Messages
  None
`
    })
})

test("sessions watch command output matches streaming designs", async () => {
    // given a running session with existing history
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({
        kind: "coding-agent",
        client: "fixture-agent",
        provider: "fixture-provider",
        model: "fixture-model"
    })
    let completed = false
    onTestFinished(() => {
        if (!completed) recorder.fail()
    })
    recorder.addMessage("user", "Existing context.")
    const runningSession = await loopy.sessions.get(recorder.id)
    const watch = startCliCommand(["sessions", "watch", recorder.id], serverEnv(await testServer(loopy)))
    await waitForOutput(watch.stdout, "user       Existing context.")

    // when multiline messages and tool activity arrive before the session completes
    recorder.addMessage("assistant", "First line\n\n  indented line")
    await waitForOutput(watch.stdout, "indented line")
    recorder.addToolCall({
        id: "call-1",
        name: "lookup",
        source: { kind: "mcp", server: "docs" },
        input: { query: "streaming" }
    })
    recorder.addToolResult({ toolCallId: "call-1", status: "succeeded", output: { matches: 3 } })
    await waitForOutput(watch.stdout, '"matches":3')
    recorder.addMessage("assistant", "Complete.")
    recorder.succeed()
    completed = true
    const code = await watch.done

    // then history and live messages share one aligned stream without a terminal status update
    expect(code).toBe(0)
    expect(watch.stderr()).toBe("")
    expect(watch.stdout()).toBe(`Session ${recorder.id}
  coding-agent · fixture-agent · fixture-provider/fixture-model
  running · from ${minute(runningSession.startedAt)}

Messages
  user       Existing context.
  assistant  First line

               indented line
  tool       {"id":"call-1","tool":"docs.lookup","input":{"query":"streaming"}}
  result     {"toolUseId":"call-1","status":"succeeded","content":{"matches":3}}
  assistant  Complete.
`)
})
