import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { BaseLanguageModel, type LanguageModelInvocation } from "@loopy/core/ai/base-llm"
import type { AISessionMessage } from "@loopy/core/ai/sessions"
import { gate, tempDir, tempLoopy, testRun } from "@loopy/test-utils"

function textMessage(message: AISessionMessage): Extract<AISessionMessage, { type: "message" }> {
    if (message.type !== "message") throw new Error(`Expected message, received ${message.type}`)
    return message
}

test("session filesRoot normalizes common tool paths", async () => {
    // given a worktree, duplicate change paths, a search path and an absolute path outside it
    const parent = tempDir("loopy-session-files-")
    const worktree = path.join(parent, "worktree")
    const outside = path.join(parent, "shared.ts")
    fs.mkdirSync(worktree)
    fs.writeFileSync(outside, "")

    // when recording change and search calls against the worktree root
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({
        kind: "coding-agent",
        client: "fake-agent",
        provider: "fake",
        model: "m",
        filesRoot: worktree
    })
    recorder.addToolCall({
        id: "call-1",
        name: "edit",
        source: { kind: "native" },
        input: {},
        common: { name: "file.change", paths: ["src/a.ts", "src/../src/a.ts", outside] }
    })
    recorder.addToolCall({
        id: "call-2",
        name: "grep",
        source: { kind: "native" },
        input: { pattern: "needle", path: "src/../src" },
        common: { name: "file.search", pattern: "needle", path: "src/../src" }
    })
    recorder.succeed()

    // then paths are normalized, deduplicated and retain their first-seen order
    const messages = (await loopy.sessions.get(recorder.id)).messages
    expect(messages[0]).toMatchObject({
        type: "tool_call",
        toolCall: {
            common: {
                name: "file.change",
                paths: ["src/a.ts", fs.realpathSync(outside).split(path.sep).join("/")]
            }
        }
    })
    expect(messages[1]).toMatchObject({
        type: "tool_call",
        toolCall: {
            input: { pattern: "needle", path: "src/../src" },
            common: { name: "file.search", pattern: "needle", path: "src" }
        }
    })
})

test("session filesRoot recognizes canonical paths beneath a symlinked worktree", async () => {
    // given a worktree reached through a symlink and a canonical target beneath it
    const parent = tempDir("loopy-session-symlink-")
    const realWorktree = path.join(parent, "real-worktree")
    const linkedWorktree = path.join(parent, "linked-worktree")
    fs.mkdirSync(realWorktree)
    fs.symlinkSync(realWorktree, linkedWorktree, process.platform === "win32" ? "junction" : "dir")
    const target = path.join(fs.realpathSync(realWorktree), "src", "a.ts")

    // when recording the canonical target against the symlinked root
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({
        kind: "coding-agent",
        client: "fake-agent",
        provider: "fake",
        model: "m",
        filesRoot: linkedWorktree
    })
    recorder.addToolCall({
        id: "call-1",
        name: "read",
        source: { kind: "native" },
        input: {},
        common: { name: "file.read", path: target }
    })
    recorder.succeed()

    // then the target is represented relative to the worktree
    const message = (await loopy.sessions.get(recorder.id)).messages[0]
    expect(message).toMatchObject({
        type: "tool_call",
        toolCall: { common: { name: "file.read", path: "src/a.ts" } }
    })
})

test("sessions without filesRoot preserve recorded file targets", async () => {
    // given a session without a files root
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })

    // when recording a non-normalized file target
    recorder.addToolCall({
        id: "call-1",
        name: "read",
        source: { kind: "native" },
        input: {},
        common: { name: "file.read", path: "src/../src/a.ts" }
    })
    recorder.succeed()

    // then the target is stored as supplied
    const message = (await loopy.sessions.get(recorder.id)).messages[0]
    expect(message).toMatchObject({
        type: "tool_call",
        toolCall: { common: { name: "file.read", path: "src/../src/a.ts" } }
    })
})

test("tool calls normalize an absent input to JSON null", async () => {
    // given an active session
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({
        kind: "coding-agent",
        client: "fake-agent",
        provider: "fake",
        model: "m"
    })

    // when recording a tool call whose provider omitted its input
    recorder.addToolCall({ id: "call-1", name: "noop", source: { kind: "mcp", server: "fake" }, input: undefined })
    recorder.succeed()

    // then recording succeeds with a JSON null input
    expect((await loopy.sessions.get(recorder.id)).messages[0]).toMatchObject({
        type: "tool_call",
        toolCall: { id: "call-1", input: null }
    })
    expect((await loopy.sessions.get(recorder.id)).messages[0]).not.toHaveProperty("toolCall.common")
})

test("common tool arguments and raw inputs round-trip", async () => {
    // given one call for every common tool and one non-common tool
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })
    const calls = [
        {
            id: "read",
            name: "Read",
            source: { kind: "native" as const },
            input: { file_path: "a.ts", offset: 10 },
            common: { name: "file.read" as const, path: "a.ts" }
        },
        {
            id: "change",
            name: "Edit",
            source: { kind: "native" as const },
            input: { file_path: "a.ts", old_string: "a", new_string: "b" },
            common: { name: "file.change" as const, paths: ["a.ts"] }
        },
        {
            id: "shell",
            name: "Bash",
            source: { kind: "native" as const },
            input: { command: "pnpm test", timeout: 1000 },
            common: { name: "shell.execute" as const, command: "pnpm test" }
        },
        {
            id: "file-search",
            name: "Grep",
            source: { kind: "native" as const },
            input: { pattern: "needle", path: "src", glob: "*.ts" },
            common: { name: "file.search" as const, pattern: "needle", path: "src" }
        },
        {
            id: "web-search",
            name: "WebSearch",
            source: { kind: "provider" as const },
            input: { query: "loopy", allowed_domains: ["example.com"] },
            common: { name: "web.search" as const, query: "loopy" }
        },
        {
            id: "custom",
            name: "lookup",
            source: { kind: "mcp" as const, server: "docs" },
            input: { key: "sessions" }
        }
    ]

    // when the calls are recorded and loaded
    for (const call of calls) recorder.addToolCall(call)
    recorder.succeed()
    const recorded = (await loopy.sessions.get(recorder.id)).messages.map((message) => {
        if (message.type !== "tool_call") throw new Error(`Expected tool call, received ${message.type}`)
        return message.toolCall
    })

    // then normalized arguments and complete raw inputs are preserved without adding common data to the custom call
    expect(recorded).toEqual(calls)
})

test("get returns ordered session messages and stream yields them in order", async () => {
    // given a session with messages and paired tool activity that has succeeded
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })
    recorder.addMessage("system", "sys")
    recorder.addMessage("user", "hi")
    recorder.addMessage("reasoning", "think")
    recorder.addToolCall({
        id: "call-1",
        name: "Read",
        source: { kind: "native" },
        input: { file_path: "a.ts" },
        common: { name: "file.read", path: "a.ts" }
    })
    recorder.addToolResult({ toolCallId: "call-1", status: "succeeded", output: "contents" })
    recorder.addMessage("assistant", "hello")
    recorder.succeed()

    // when getting the session
    const session = await loopy.sessions.get(recorder.id)

    // then its identity fields round-trip and it is succeeded
    expect(session).toMatchObject({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })
    expect(session.status).toBe("succeeded")
    // and every message is returned in insertion order with canonical tool data
    expect(session.messages.map((message) => message.type)).toEqual([
        "message",
        "message",
        "message",
        "tool_call",
        "tool_result",
        "message"
    ])
    expect(session.messages[3]).toMatchObject({
        toolCall: {
            id: "call-1",
            name: "Read",
            source: { kind: "native" },
            input: { file_path: "a.ts" },
            common: { name: "file.read", path: "a.ts" }
        }
    })
    expect(session.messages[4]).toMatchObject({
        toolResult: { toolCallId: "call-1", status: "succeeded", output: "contents" }
    })
    // and streaming the session yields the same messages in order
    expect((await Array.fromAsync(loopy.sessions.stream(recorder.id))).map((message) => message.id)).toEqual(
        session.messages.map((message) => message.id)
    )
})

test("stream with afterMessageId replays only later messages of an ended session", async () => {
    // given a succeeded session with three messages
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })
    recorder.addMessage("system", "sys")
    recorder.addMessage("user", "hi")
    recorder.addMessage("assistant", "hello")
    recorder.succeed()
    const session = await loopy.sessions.get(recorder.id)

    // when streaming after the first message's id
    const messages = await Array.fromAsync(
        loopy.sessions.stream(recorder.id, { afterMessageId: session.messages[0]!.id })
    )

    // then only the messages after it are replayed
    expect(messages.map((message) => textMessage(message).content)).toEqual(["hi", "hello"])
})

test("stream tails an active session until it ends", async () => {
    // given an active session with one message
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })
    recorder.addMessage("user", "one")

    // when streaming the session
    const stream = loopy.sessions.stream(recorder.id)

    // then it yields the existing message first
    expect(textMessage((await stream.next()).value!).content).toBe("one")

    // when a new message is added while a read is pending
    const pending = stream.next()
    recorder.addMessage("assistant", "two")

    // then the pending read resolves with the new message
    expect(textMessage((await pending).value!).content).toBe("two")

    // when the session succeeds
    recorder.succeed()

    // then the stream ends
    expect((await stream.next()).done).toBe(true)
})

test("stream with afterMessageId on an active session yields only new messages", async () => {
    // given an active session with two messages
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })
    recorder.addMessage("user", "one")
    recorder.addMessage("assistant", "two")
    const session = await loopy.sessions.get(recorder.id)
    const lastId = session.messages.at(-1)!.id

    // when streaming after the last existing message's id
    const stream = loopy.sessions.stream(recorder.id, { afterMessageId: lastId })
    const pending = stream.next()

    // and a new message is added
    recorder.addMessage("assistant", "three")

    // then only the new message is yielded
    expect(textMessage((await pending).value!).content).toBe("three")

    // when the session succeeds
    recorder.succeed()

    // then the stream ends
    expect((await stream.next()).done).toBe(true)
})

test("stream on a missing session throws", async () => {
    // given no session with the given id
    const { loopy } = tempLoopy()

    // when streaming an unknown session id
    // then it throws a not found error
    await expect(loopy.sessions.stream("nope").next()).rejects.toMatchObject({
        message: expect.stringMatching(/not found/),
        code: "ai_session_not_found"
    })
})

test("stream with an unknown or foreign afterMessageId throws", async () => {
    // given a succeeded session and a message belonging to another session
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })
    recorder.addMessage("user", "hi")
    recorder.succeed()
    const other = loopy.sessions.create({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })
    other.addMessage("user", "elsewhere")
    other.succeed()
    const foreignId = (await loopy.sessions.get(other.id)).messages[0]!.id

    // when streaming with an unknown afterMessageId
    // then it throws a message not found error
    await expect(loopy.sessions.stream(recorder.id, { afterMessageId: "nope" }).next()).rejects.toMatchObject({
        message: expect.stringMatching(/Message not found/),
        code: "ai_session_message_not_found"
    })
    // and when streaming with another session's message id
    // then it also throws a message not found error
    await expect(loopy.sessions.stream(recorder.id, { afterMessageId: foreignId }).next()).rejects.toMatchObject({
        message: expect.stringMatching(/Message not found/),
        code: "ai_session_message_not_found"
    })
})

test("breaking out of a stream deregisters the listener without breaking the recorder", async () => {
    // given an active session with one message
    const { loopy } = tempLoopy()
    const recorder = loopy.sessions.create({ kind: "llm", client: "fake-llm", provider: "fake", model: "m" })
    recorder.addMessage("user", "one")

    // when breaking out of the stream after the first message
    for await (const message of loopy.sessions.stream(recorder.id)) {
        expect(textMessage(message).content).toBe("one")
        break
    }

    // then the recorder still accepts further messages and can succeed
    recorder.addMessage("assistant", "two")
    recorder.succeed()
    // and the session ends up with both messages
    expect((await loopy.sessions.get(recorder.id)).messages).toHaveLength(2)
})

test("get on a missing session throws", async () => {
    // given no session with the given id
    const { loopy } = tempLoopy()

    // when getting an unknown session id
    // then it throws a not found error
    await expect(loopy.sessions.get("nope")).rejects.toMatchObject({
        message: expect.stringMatching(/not found/),
        code: "ai_session_not_found"
    })
})

class ParkingLLM extends BaseLanguageModel {
    readonly client = "fake-llm"
    readonly provider = "fake"
    readonly model = "parking"

    constructor(
        private readonly reached: () => void,
        private readonly parked: Promise<void>
    ) {
        super()
    }

    protected async invoke({ prompt, session }: LanguageModelInvocation): Promise<unknown> {
        session.addMessage("user", prompt)
        session.addMessage("reasoning", "thinking...")
        this.reached()
        await this.parked
        return { summary: "s" }
    }
}

test("an active session is observed as running, and as interrupted after a crash", async () => {
    // given an llm call that parks after emitting one message
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    const llm = new ParkingLLM(reached.release, parked.released)
    testRun(loopy, async () => llm.call("summarize", { prompt: "p", output: z.object({ summary: z.string() }) })).catch(
        () => {}
    )
    await reached.released
    const sessionId = (loopy.db.prepare("SELECT id FROM sessions").get() as { id: string }).id

    // then the session is observed as running while parked
    expect((await loopy.sessions.get(sessionId)).status).toBe("running")

    // when reopening loopy to simulate a crash and restart
    const second = reopen()
    const observed = await second.sessions.get(sessionId)

    // then the session is observed as interrupted
    expect(observed.status).toBe("interrupted")
    // and its messages up to the crash are preserved
    expect(observed.messages.map((message) => textMessage(message).content)).toEqual(["p", "thinking..."])
    expect(observed.messages.map((message) => textMessage(message).role)).toEqual(["user", "reasoning"])
    // and streaming the session replays the same messages
    expect(
        (await Array.fromAsync(second.sessions.stream(sessionId))).map((message) => textMessage(message).content)
    ).toEqual(["p", "thinking..."])
})
