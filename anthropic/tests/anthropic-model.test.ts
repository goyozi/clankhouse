import * as z from "zod"
import { expect, test } from "vitest"
import { AnthropicModel } from "@loopy/anthropic"
import { sessionTextMessages, taggedOutput, tempLoopy, testRun } from "@loopy/test-utils"
import { fakeAnthropic, redactedThinkingBlock, textBlock, thinkingBlock } from "./fake-anthropic"

const outputSchema = z.object({ done: z.boolean() })
const complexOutputSchema = z.array(
    z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("calculation"), expression: z.string(), value: z.number() }),
        z.object({ kind: z.literal("status"), done: z.boolean(), note: z.string().optional() })
    ])
)

test("AnthropicModel uses the official streaming client and records thinking separately", async () => {
    // given an official Anthropic response containing text around a thinking block
    const { loopy } = tempLoopy()
    const expected = [
        { kind: "calculation" as const, expression: "6 * 7", value: 42 },
        { kind: "status" as const, done: true }
    ]
    const assistantReply = (prompt: string) =>
        `extra prefix\n${taggedOutput(prompt, JSON.stringify(expected))}\nextra suffix`
    const fake = fakeAnthropic((prompt) => {
        const reply = assistantReply(prompt)
        const splitAt = reply.indexOf(JSON.stringify(expected))
        return [
            textBlock(reply.slice(0, splitAt)),
            thinkingBlock("Checked the calculation."),
            textBlock(reply.slice(splitAt))
        ]
    })
    const model = new AnthropicModel({
        model: "claude-test",
        maxTokens: 2048,
        clientOptions: fake.clientOptions
    })

    // when the model is called inside a durable step
    const result = await testRun(loopy, async () =>
        model.call("calculate", { prompt: "Calculate the requested result.", output: complexOutputSchema })
    )

    // then the official stream produces the structured result and exact request
    expect(result).toEqual(expected)
    expect(fake.requests).toEqual([
        {
            model: "claude-test",
            max_tokens: 2048,
            messages: [{ role: "user", content: expect.any(String) }],
            stream: true
        }
    ])
    const prompt = fake.requests[0].messages[0].content
    if (typeof prompt !== "string") throw new Error("unreachable")
    expect(prompt).toMatch(/^Calculate the requested result\.\n\nIMPORTANT — requested final answer:/)
    // and thinking is a reasoning event rather than an assistant message
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    const reply = assistantReply(prompt)
    const splitAt = reply.indexOf(JSON.stringify(expected))
    expect(session).toMatchObject({
        kind: "llm",
        client: "anthropic",
        provider: "anthropic",
        model: "claude-test",
        status: "succeeded"
    })
    expect(sessionTextMessages(session.messages).map((message) => [message.role, message.content])).toEqual([
        ["user", prompt],
        ["assistant", reply.slice(0, splitAt)],
        ["reasoning", "Checked the calculation."],
        ["assistant", reply.slice(splitAt)]
    ])
})

test("AnthropicModel returns its combined final text verbatim for a root string output", async () => {
    // given an official response whose final text is split around a thinking block
    const { loopy } = tempLoopy()
    const first = '  {"answer":"natural"}\n'
    const second = "No framing.  "
    const fake = fakeAnthropic(() => [textBlock(first), thinkingBlock("Checked the answer."), textBlock(second)])
    const model = new AnthropicModel({ model: "claude-test", maxTokens: 256, clientOptions: fake.clientOptions })

    // when the model is called with a root string schema
    const result = await testRun(loopy, () => model.call("answer", { prompt: "Answer naturally.", output: z.string() }))

    // then the official client receives the bare prompt and all final text is returned exactly
    expect(fake.requests[0].messages[0].content).toBe("Answer naturally.")
    expect(result).toBe(first + second)
    // and the durable output stores the combined string while the session retains provider blocks
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    expect(step.outputJson).toBe(JSON.stringify(first + second))
    expect(
        sessionTextMessages((await loopy.sessions.get(step.sessionId!)).messages).map((message) => message.content)
    ).toEqual(["Answer naturally.", first, "Checked the answer.", second])
})

test("AnthropicModel records readable thinking but drops redacted thinking", async () => {
    // given an official response mixing readable thinking with an encrypted redacted block
    const { loopy } = tempLoopy()
    const ciphertext = "RWtaTVNVSkJVMFVnUlU1RFVsbFFWRVZFSUdSaGRHRT0="
    const fake = fakeAnthropic((prompt) => [
        thinkingBlock("Checked the calculation."),
        redactedThinkingBlock(ciphertext),
        textBlock(taggedOutput(prompt, '{"done":true}'))
    ])
    const model = new AnthropicModel({ model: "claude-test", maxTokens: 256, clientOptions: fake.clientOptions })

    // when the model is called
    const result = await testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then only the readable thinking is durable and the ciphertext is nowhere in the session
    expect(result).toEqual({ done: true })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    const messages = sessionTextMessages(session.messages)
    expect(messages.map((message) => [message.role, message.content])).toEqual([
        ["user", expect.any(String)],
        ["reasoning", "Checked the calculation."],
        ["assistant", expect.stringContaining('{"done":true}')]
    ])
    expect(messages.some((message) => message.content.includes(ciphertext))).toBe(false)
})

test("AnthropicModel rejects a void output before making an SDK request", async () => {
    // given an official client transport and a void output schema
    const { loopy } = tempLoopy()
    const fake = fakeAnthropic(() => [textBlock("unused")])
    const model = new AnthropicModel({ model: "claude-test", maxTokens: 256, clientOptions: fake.clientOptions })

    // when the model is called
    const result = testRun(
        loopy,
        async () => model.call("notify", { prompt: "Send the notification.", output: z.void() }),
        { output: z.void() }
    )

    // then schema validation prevents both the request and durable side effects
    await expect(result).rejects.toThrow(/LLM "notify" output schema.*z\.void\(\)/)
    expect(fake.requests).toHaveLength(0)
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    expect(run.steps).toHaveLength(0)
    expect(loopy.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 })
})

test("AnthropicModel streams token caps above the SDK non-streaming ceiling", async () => {
    // given an official Anthropic model whose configured token cap requires streaming
    const { loopy } = tempLoopy()
    const fake = fakeAnthropic((prompt) => [textBlock(taggedOutput(prompt, '{"done":true}'))])
    const model = new AnthropicModel({
        model: "claude-opus-4-0",
        maxTokens: 30_000,
        clientOptions: fake.clientOptions
    })

    // when a structured-output call is executed
    const result = await testRun(loopy, async () =>
        model.call("long", { prompt: "Write a long response.", output: outputSchema })
    )

    // then the real SDK accepts the request because the adapter uses its streaming API
    expect(result).toEqual({ done: true })
    expect(fake.requests[0]).toMatchObject({ model: "claude-opus-4-0", max_tokens: 30_000, stream: true })
})

test("AnthropicModel reports truncation before parsing instructed output", async () => {
    // given an official streamed response stopped by the output-token limit
    const { loopy } = tempLoopy()
    const fake = fakeAnthropic(() => ({
        content: [textBlock("partial tagged response")],
        stopReason: "max_tokens"
    }))
    const model = new AnthropicModel({ model: "claude-test", maxTokens: 256, clientOptions: fake.clientOptions })

    // when the model is called
    const result = testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then the provider completion error wins over instructed-output parsing
    await expect(result).rejects.toMatchObject({
        code: "llm_response_incomplete",
        message: expect.stringContaining("max_tokens")
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    expect(
        sessionTextMessages((await loopy.sessions.get(step.sessionId!)).messages).map((message) => message.role)
    ).toEqual(["user", "assistant"])
})

test("AnthropicModel rejects tool output from a request that supplied no tools", async () => {
    // given an official tool-use content block despite the request containing no tools
    const { loopy } = tempLoopy()
    const fake = fakeAnthropic(() => ({
        content: [
            {
                type: "tool_use",
                id: "tool_test",
                caller: { type: "direct" },
                name: "calculator",
                input: { expression: "6 * 7" }
            }
        ],
        stopReason: "tool_use"
    }))
    const model = new AnthropicModel({ model: "claude-test", maxTokens: 256, clientOptions: fake.clientOptions })

    // when the model is called
    const result = testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then the impossible result fails loudly instead of becoming a tool or assistant message
    await expect(result).rejects.toMatchObject({
        code: "llm_response_invalid",
        message: expect.stringContaining("tool_use")
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    expect(
        sessionTextMessages((await loopy.sessions.get(step.sessionId!)).messages).map((message) => message.role)
    ).toEqual(["user"])
})

test.each([
    ["missing tags", () => textBlock('{"done":true}'), "ai_output_missing"],
    ["invalid JSON", (prompt: string) => textBlock(taggedOutput(prompt, "not json")), "ai_output_invalid"]
] as const)("AnthropicModel reports %s from official text output", async (_case, reply, code) => {
    // given an official text response that violates instructed-output framing
    const { loopy } = tempLoopy()
    const fake = fakeAnthropic((prompt) => [reply(prompt)])
    const model = new AnthropicModel({ model: "claude-test", maxTokens: 256, clientOptions: fake.clientOptions })

    // when the model is called
    const result = testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then the shared instructed-output error is preserved
    await expect(result).rejects.toMatchObject({ code })
})

test("AnthropicModel preserves the prompt when the official client request fails", async () => {
    // given a fetch transport that fails beneath the official client
    const { loopy } = tempLoopy()
    const fake = fakeAnthropic(() => {
        throw new Error("connection lost")
    })
    const model = new AnthropicModel({ model: "claude-test", maxTokens: 256, clientOptions: fake.clientOptions })

    // when the model is called
    const result = testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then the SDK failure propagates and only the durable user prompt remains
    await expect(result).rejects.toThrow()
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.status).toBe("failed")
    expect(sessionTextMessages(session.messages).map((message) => message.role)).toEqual(["user"])
})

test("AnthropicModel replay skips a second official client request", async () => {
    // given a persisted successful call through an official client
    const { loopy, reopen } = tempLoopy()
    const fake = fakeAnthropic((prompt) => [textBlock(taggedOutput(prompt, '{"done":true}'))])
    const initialModel = new AnthropicModel({
        model: "claude-test",
        maxTokens: 256,
        clientOptions: fake.clientOptions
    })
    const initialBody = () => initialModel.call("check", { prompt: "Check.", output: outputSchema })
    expect(await testRun(loopy, initialBody)).toEqual({ done: true })

    // when a fresh model replays the durable call
    const replayed = reopen()
    const replayedModel = new AnthropicModel({
        model: "claude-test",
        maxTokens: 256,
        clientOptions: fake.clientOptions
    })
    const result = await testRun(replayed, () =>
        replayedModel.call("check", { prompt: "Check.", output: outputSchema })
    )

    // then stored output is returned without another fetch
    expect(result).toEqual({ done: true })
    expect(fake.requests).toHaveLength(1)
    expect(replayed.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 })
})

test.skipIf(!process.env.ANTHROPIC_MODEL_LIVE_TEST)(
    "live: AnthropicModel returns a non-trivial instructed output",
    { timeout: 180_000 },
    async () => {
        // given a real Anthropic model using standard SDK environment credentials
        const { loopy } = tempLoopy()
        const model = new AnthropicModel({ model: "claude-sonnet-4-6", maxTokens: 1024 })

        // when it is asked for an exact array-root discriminated union
        const result = await testRun(loopy, async () =>
            model.call("calculate", {
                prompt: `Calculate 6 * 7.

Answer with exactly two array entries in order: a calculation entry with expression "6 * 7" and value 42, then a status entry with done true. Omit the optional note.`,
                output: complexOutputSchema
            })
        )

        // then it returns the exact typed answer and normalized assistant/reasoning events
        expect(result).toEqual([
            { kind: "calculation", expression: "6 * 7", value: 42 },
            { kind: "status", done: true }
        ])
        const run = await loopy.runs.get((await loopy.runs.list())[0].id)
        const step = run.steps[0]
        if (step.kind !== "llm") throw new Error("unreachable")
        const session = await loopy.sessions.get(step.sessionId!)
        expect(session.status).toBe("succeeded")
        const messages = sessionTextMessages(session.messages)
        expect(messages[0].role).toBe("user")
        expect(messages.slice(1).every((message) => ["assistant", "reasoning"].includes(message.role))).toBe(true)
        expect(messages.some((message) => message.role === "assistant")).toBe(true)
    }
)
