import { PassThrough, Readable } from "node:stream"
import { create } from "@bufbuild/protobuf"
import { timestampFromDate } from "@bufbuild/protobuf/wkt"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { listen, type ClankHouseServer } from "@clankhouse/server"
import { SessionMessageSchema, ToolResultStatus } from "@clankhouse/server/proto"
import { tempClankHouse } from "@clankhouse/test-utils"
import { expect, onTestFinished, test } from "vitest"
import { runCli } from "../../../src"
import { formatSessionMessage } from "../../../src/cmd/sessions/output"
import { executionTiming } from "../../../src/output"

async function testServer(clankhouse: ClankHouse): Promise<ClankHouseServer> {
    const server = await listen(clankhouse, { port: 0 })
    onTestFinished(() => server.close())
    return server
}

function serverEnv(server: ClankHouseServer): NodeJS.ProcessEnv {
    return {
        ...process.env,
        CLANK_SERVER_URL: server.url,
        CLANK_API_KEY: server.apiKey
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
    const { clankhouse } = tempClankHouse()
    const detailedRecorder = clankhouse.sessions.create({
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
        input: { path: "README.md" },
        common: { name: "file.read", path: "README.md" }
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
    const emptyRecorder = clankhouse.sessions.create({
        kind: "llm",
        client: "fixture-llm",
        provider: "fixture-provider",
        model: "fixture-model"
    })
    emptyRecorder.succeed()
    const hiddenRecorder = clankhouse.sessions.create({
        kind: "llm",
        client: "fixture-llm",
        provider: "fixture-provider",
        model: "fixture-model"
    })
    hiddenRecorder.addToolResult({ toolCallId: "orphan", status: "succeeded", output: "hidden" })
    hiddenRecorder.succeed()
    const detailedSession = await clankhouse.sessions.get(detailedRecorder.id)
    const emptySession = await clankhouse.sessions.get(emptyRecorder.id)
    const hiddenSession = await clankhouse.sessions.get(hiddenRecorder.id)
    const env = serverEnv(await testServer(clankhouse))

    // when both sessions are requested in compact and expanded human-readable forms
    const detailed = await runCliCommand(["sessions", "get", detailedRecorder.id], env)
    const empty = await runCliCommand(["sessions", "get", emptyRecorder.id], env)
    const hidden = await runCliCommand(["sessions", "get", hiddenRecorder.id], env)
    const expanded = await runCliCommand(
        ["sessions", "get", detailedRecorder.id, "--include", "tool-io", "--include", "tool-io"],
        env
    )
    const all = await runCliCommand(["sessions", "get", detailedRecorder.id, "--include", "all"], env)
    const verbose = await runCliCommand(["sessions", "get", detailedRecorder.id, "--verbose"], env)

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
  tool       read README.md
  tool       docs.lookup (mcp)
  result     failed: unavailable
  reasoning  The evidence is sufficient.
`
    })

    // and each expanded form preserves the summaries and adds complete tool input and result envelopes
    const expandedOutput = `Session ${detailedRecorder.id}
  coding-agent · fixture-agent · fixture-provider/fixture-model
  succeeded · ${duration(detailedSession.startedAt, detailedSession.endedAt)}

Messages
  system     Follow the review policy.
  user       Review this

             carefully
  assistant    Preserve this indentation.
             Then continue.
  tool       read README.md
  input      {"id":"call-1","tool":"read","input":{"path":"README.md"}}
  result     {"toolUseId":"call-1","status":"succeeded","content":{"lines":2}}
  tool       docs.lookup (mcp)
  input      {"id":"call-2","tool":"docs.lookup","input":{"query":"sessions"}}
  result     {"toolUseId":"call-2","status":"failed","content":null,"error":"unavailable"}
  reasoning  The evidence is sufficient.
`
    expect(expanded).toEqual({ code: 0, stderr: "", stdout: expandedOutput })
    expect(all).toEqual({ code: 0, stderr: "", stdout: expandedOutput })
    expect(verbose).toEqual({ code: 0, stderr: "", stdout: expandedOutput })

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
    expect(hidden).toEqual({
        code: 0,
        stderr: "",
        stdout: `Session ${hiddenRecorder.id}
  llm · fixture-llm · fixture-provider/fixture-model
  succeeded · ${duration(hiddenSession.startedAt, hiddenSession.endedAt)}

Messages
  None
`
    })
})

test("sessions watch command output matches streaming designs", async () => {
    // given a running session with existing history
    const { clankhouse } = tempClankHouse()
    const recorder = clankhouse.sessions.create({
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
    const runningSession = await clankhouse.sessions.get(recorder.id)
    const env = serverEnv(await testServer(clankhouse))
    const watch = startCliCommand(["sessions", "watch", recorder.id], env)
    const expandedWatch = startCliCommand(["sessions", "watch", recorder.id, "--include", "all"], env)
    await waitForOutput(watch.stdout, "user       Existing context.")
    await waitForOutput(expandedWatch.stdout, "user       Existing context.")

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
    await waitForOutput(expandedWatch.stdout, '"matches":3')
    recorder.addMessage("assistant", "Complete.")
    recorder.succeed()
    completed = true
    const code = await watch.done
    const expandedCode = await expandedWatch.done

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
  tool       docs.lookup (mcp)
  assistant  Complete.
`)
    expect(expandedCode).toBe(0)
    expect(expandedWatch.stderr()).toBe("")
    expect(expandedWatch.stdout()).toBe(`Session ${recorder.id}
  coding-agent · fixture-agent · fixture-provider/fixture-model
  running · from ${minute(runningSession.startedAt)}

Messages
  user       Existing context.
  assistant  First line

               indented line
  tool       docs.lookup (mcp)
  input      {"id":"call-1","tool":"docs.lookup","input":{"query":"streaming"}}
  result     {"toolUseId":"call-1","status":"succeeded","content":{"matches":3}}
  assistant  Complete.
`)
})

test("session tool summaries cover common tools, source fallbacks, escaping, and truncation", async () => {
    // given a completed session containing every common tool kind and fallback source
    const { clankhouse } = tempClankHouse()
    const recorder = clankhouse.sessions.create({
        kind: "coding-agent",
        client: "fixture-agent",
        provider: "fixture-provider",
        model: "fixture-model"
    })
    recorder.addToolCall({
        id: "read",
        name: "Read",
        source: { kind: "native" },
        input: {},
        common: { name: "file.read", path: "src/index.ts" }
    })
    recorder.addToolCall({
        id: "change",
        name: "Edit",
        source: { kind: "native" },
        input: {},
        common: { name: "file.change", paths: ["src/a.ts", "src/b.ts"] }
    })
    recorder.addToolCall({
        id: "shell",
        name: "Bash",
        source: { kind: "native" },
        input: {},
        common: { name: "shell.execute", command: "pnpm test\n--run\tall" }
    })
    recorder.addToolCall({
        id: "search",
        name: "Grep",
        source: { kind: "native" },
        input: {},
        common: { name: "file.search", pattern: "needle", path: "src" }
    })
    recorder.addToolCall({
        id: "web",
        name: "WebSearch",
        source: { kind: "provider" },
        input: {},
        common: { name: "web.search", query: "x".repeat(200) }
    })
    recorder.addToolCall({
        id: "escaped-boundary",
        name: "WebSearch",
        source: { kind: "provider" },
        input: {},
        common: { name: "web.search", query: `${"x".repeat(147)}\ntail` }
    })
    recorder.addToolCall({ id: "native", name: "inspect", source: { kind: "native" }, input: {} })
    recorder.addToolCall({ id: "provider", name: "web_search", source: { kind: "provider" }, input: {} })
    recorder.addToolCall({ id: "mcp", name: "read_notion_page", source: { kind: "mcp", server: "notion" }, input: {} })
    recorder.addToolCall({
        id: "mcp-duplicate",
        name: "read_notion_page",
        source: { kind: "mcp", server: "docs" },
        input: {}
    })
    recorder.addToolResult({ toolCallId: "mcp", status: "succeeded", error: "inconsistent result" })
    recorder.succeed()
    const env = serverEnv(await testServer(clankhouse))

    // when the session is requested in compact form
    const result = await runCliCommand(["sessions", "get", recorder.id], env)
    const toolLines = result.stdout.split("\n").filter((line) => line.startsWith("  tool"))

    // then semantic summaries stay on one line, source kinds are concise, and long details are capped
    expect(toolLines.slice(0, 4)).toEqual([
        "  tool       read src/index.ts",
        "  tool       change src/a.ts, src/b.ts",
        "  tool       shell pnpm test\\n--run\\tall",
        "  tool       search needle in src"
    ])
    expect(toolLines[4]!.slice("  tool       ".length)).toHaveLength(160)
    expect(toolLines[4]).toMatch(/…$/)
    expect(toolLines[5]).toBe(`  tool       web_search ${"x".repeat(147)}…`)
    expect(toolLines.slice(6)).toEqual([
        "  tool       inspect",
        "  tool       web_search (provider)",
        "  tool       notion.read_notion_page (mcp)",
        "  tool       docs.read_notion_page (mcp)"
    ])
    expect(result.stdout).toContain("  result     failed: inconsistent result")
})

test("compact tool results preserve unspecified status", () => {
    // given a tool result carrying the protobuf default status
    const message = create(SessionMessageSchema, {
        payload: {
            case: "toolResult",
            value: { toolCallId: "call-1", status: ToolResultStatus.UNSPECIFIED }
        }
    })

    // when the result is formatted without expanded tool I/O
    const output = formatSessionMessage(message)

    // then the result is not mislabeled as failed
    expect(output).toBe("tool_result: unspecified\n")
})

test("session include validation reports command-specific resources", async () => {
    // given a completed session
    const { clankhouse } = tempClankHouse()
    const recorder = clankhouse.sessions.create({ kind: "llm", client: "fixture", provider: "fixture", model: "model" })
    recorder.succeed()
    const env = serverEnv(await testServer(clankhouse))

    // when an unsupported session include is requested
    const result = await runCliCommand(["sessions", "get", recorder.id, "--include", "sessions"], env)

    // then the CLI rejects it and lists the session-specific choices
    expect(result.code).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("allowed values are tool-io and all")
})
