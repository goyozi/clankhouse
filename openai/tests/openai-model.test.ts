import * as z from "zod"
import { expect, test } from "vitest"
import { OpenAIModel } from "@loopy/openai"
import { sessionTextMessages, taggedOutput, taggedStringOutput, tempLoopy, testRun } from "@loopy/test-utils"
import { fakeOpenAI, openAIResponse, outputMessage, reasoningItem } from "./fake-openai"

const outputSchema = z.object({ done: z.boolean() })
const complexOutputSchema = z.array(
    z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("calculation"), expression: z.string(), value: z.number() }),
        z.object({ kind: z.literal("status"), done: z.boolean(), note: z.string().optional() })
    ])
)

test("OpenAIModel uses the official client response and records reasoning separately", async () => {
    // given an official Responses payload containing the normal reasoning item followed by text
    const { loopy } = tempLoopy()
    const expected = [
        { kind: "calculation" as const, expression: "6 * 7", value: 42 },
        { kind: "status" as const, done: true }
    ]
    const assistantReply = (prompt: string) =>
        `extra prefix\n${taggedOutput(prompt, JSON.stringify(expected))}\nextra suffix`
    const fake = fakeOpenAI((prompt) =>
        openAIResponse([reasoningItem("Checked the calculation."), outputMessage(assistantReply(prompt))])
    )
    const model = new OpenAIModel({
        model: "gpt-test",
        clientOptions: { ...fake.clientOptions, baseURL: "https://example.test/v1" }
    })

    // when the model is called inside a durable step
    const result = await testRun(loopy, async () =>
        model.call("calculate", { prompt: "Calculate the requested result.", output: complexOutputSchema })
    )

    // then the structured result and exact official-client request are preserved
    expect(result).toEqual(expected)
    expect(fake.urls).toEqual(["https://example.test/v1/responses"])
    expect(fake.requests).toEqual([{ model: "gpt-test", input: expect.any(String), store: false }])
    const prompt = fake.requests[0].input
    if (typeof prompt !== "string") throw new Error("unreachable")
    expect(prompt).toMatch(/^Calculate the requested result\.\n\nIMPORTANT — requested final answer:/)
    // and reasoning is no longer mislabeled as an assistant message
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session).toMatchObject({
        kind: "llm",
        client: "openai",
        provider: "openai",
        model: "gpt-test",
        status: "succeeded"
    })
    expect(sessionTextMessages(session.messages).map((message) => [message.role, message.content])).toEqual([
        ["user", prompt],
        ["reasoning", "Checked the calculation."],
        ["assistant", assistantReply(prompt)]
    ])
})

test("OpenAIModel returns an earlier tagged string after an untagged assistant message", async () => {
    // given an official response containing a tagged answer followed by an untagged notification
    const { loopy } = tempLoopy()
    const answer = "  All 8 issues stand as written.  "
    const monitorMessage = "The monitor resolved; there is nothing else to add."
    const fake = fakeOpenAI((prompt) =>
        openAIResponse([outputMessage(taggedStringOutput(prompt, answer)), outputMessage(monitorMessage)])
    )
    const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

    // when the model is called with a root string schema
    const result = await testRun(loopy, () => model.call("answer", { prompt: "Answer naturally.", output: z.string() }))

    // then the dedicated string prompt is used and the earlier tagged answer is returned
    const prompt = fake.requests[0].input
    if (typeof prompt !== "string") throw new Error("unreachable")
    expect(prompt).toMatch(/^Answer naturally\.\n\nIMPORTANT — requested final answer:/)
    expect(prompt).not.toMatch(/JSON/i)
    expect(result).toBe(answer)
    // and both assistant messages remain recorded while only the answer is persisted
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    expect(step.outputJson).toBe(JSON.stringify(answer))
    expect(
        sessionTextMessages((await loopy.sessions.get(step.sessionId!)).messages)
            .slice(-2)
            .map((message) => message.content)
    ).toEqual([taggedStringOutput(prompt, answer), monitorMessage])
})

test("OpenAIModel preserves an empty final text for a root string output", async () => {
    // given an official response containing a present but empty text block
    const { loopy } = tempLoopy()
    const fake = fakeOpenAI((prompt) => taggedStringOutput(prompt, ""))
    const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

    // when the model is called with an unconstrained root string schema
    const result = await testRun(loopy, () => model.call("answer", { prompt: "Answer naturally.", output: z.string() }))

    // then the empty text is returned instead of being treated as missing
    expect(result).toBe("")
    expect(fake.requests[0].input).toMatch(/^Answer naturally\.\n\nIMPORTANT — requested final answer:/)
    // and the empty string is recorded and durably persisted
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    expect(step.outputJson).toBe(JSON.stringify(""))
    expect(sessionTextMessages((await loopy.sessions.get(step.sessionId!)).messages).at(-1)!.content).toContain(
        "loopy_structured_output"
    )
})

test("OpenAIModel validates a raw final message against string checks", async () => {
    // given an official response shorter than the requested root string schema permits
    const { loopy } = tempLoopy()
    const fake = fakeOpenAI((prompt) => taggedStringOutput(prompt, "short"))
    const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

    // when the model is called with a constrained root string schema
    const result = testRun(loopy, () =>
        model.call("answer", { prompt: "Answer naturally.", output: z.string().min(10) })
    )

    // then durable output validation rejects the raw final message
    await expect(result).rejects.toThrow()
    // and both the step and session are marked as failed after receiving the instructed prompt
    expect(fake.requests[0].input).toMatch(/^Answer naturally\.\n\nIMPORTANT — requested final answer:/)
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "llm") throw new Error("unreachable")
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
})

test("OpenAIModel drops reasoning items that carry no summary", async () => {
    // given a completed response whose reasoning item has an empty summary, as when none was requested
    const { loopy } = tempLoopy()
    const fake = fakeOpenAI((prompt) =>
        openAIResponse([reasoningItem(""), outputMessage(taggedOutput(prompt, '{"done":true}'))])
    )
    const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

    // when the model is called
    const result = await testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then the empty reasoning item leaves no blank message behind
    expect(result).toEqual({ done: true })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    const session = await loopy.sessions.get(step.sessionId!)
    expect(sessionTextMessages(session.messages).map((message) => message.role)).toEqual(["user", "assistant"])
})

test("OpenAIModel can opt into server-side response storage", async () => {
    // given a model using an official client with response storage enabled
    const { loopy } = tempLoopy()
    const fake = fakeOpenAI((prompt) => taggedOutput(prompt, '{"done":true}'))
    const model = new OpenAIModel({ model: "gpt-test", store: true, clientOptions: fake.clientOptions })

    // when the model is called
    const result = await testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then the request explicitly enables storage
    expect(result).toEqual({ done: true })
    expect(fake.requests).toEqual([{ model: "gpt-test", input: expect.any(String), store: true }])
})

test("OpenAIModel rejects a void output before making an SDK request", async () => {
    // given an official client transport and a void output schema
    const { loopy } = tempLoopy()
    const fake = fakeOpenAI(() => "unused")
    const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

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

test.each(["max_output_tokens", "content_filter"] as const)(
    "OpenAIModel reports an incomplete %s response before parsing instructed output",
    async (reason) => {
        // given an official incomplete response containing partial assistant text
        const { loopy } = tempLoopy()
        const fake = fakeOpenAI(() =>
            openAIResponse([outputMessage("partial response")], {
                status: "incomplete",
                incomplete_details: { reason }
            })
        )
        const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

        // when the model is called
        const result = testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

        // then the provider completion error wins over instructed-output parsing
        await expect(result).rejects.toMatchObject({
            code: "llm_response_incomplete",
            message: expect.stringContaining(reason)
        })
        const run = await loopy.runs.get((await loopy.runs.list())[0].id)
        const step = run.steps[0]
        if (step.kind !== "llm") throw new Error("unreachable")
        expect(
            sessionTextMessages((await loopy.sessions.get(step.sessionId!)).messages).map((message) => message.role)
        ).toEqual(["user", "assistant"])
    }
)

test("OpenAIModel rejects tool output from a request that supplied no tools", async () => {
    // given an official function-call output item despite the request containing no tools
    const { loopy } = tempLoopy()
    const fake = fakeOpenAI(() =>
        openAIResponse([
            {
                type: "function_call",
                id: "call_test",
                call_id: "call_test",
                name: "calculator",
                arguments: '{"expression":"6 * 7"}',
                status: "completed"
            }
        ])
    )
    const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

    // when the model is called
    const result = testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then the impossible provider result fails loudly instead of becoming a tool or assistant message
    await expect(result).rejects.toMatchObject({
        code: "llm_response_invalid",
        message: expect.stringContaining("function_call")
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    expect(
        sessionTextMessages((await loopy.sessions.get(step.sessionId!)).messages).map((message) => message.role)
    ).toEqual(["user"])
})

test("OpenAIModel rejects and records an official refusal", async () => {
    // given a completed response containing an assistant refusal
    const { loopy } = tempLoopy()
    const fake = fakeOpenAI(() =>
        openAIResponse([
            {
                id: "msg_refusal",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "refusal", refusal: "I cannot answer that." }]
            }
        ])
    )
    const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

    // when the model is called
    const result = testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then the refusal is reported and retained as assistant output
    await expect(result).rejects.toMatchObject({
        code: "llm_response_failed",
        message: expect.stringContaining("I cannot answer that.")
    })
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    if (step.kind !== "llm") throw new Error("unreachable")
    expect(
        sessionTextMessages((await loopy.sessions.get(step.sessionId!)).messages).map((message) => [
            message.role,
            message.content
        ])
    ).toEqual([
        ["user", expect.any(String)],
        ["assistant", "I cannot answer that."]
    ])
})

test.each([
    ["missing tags", (): string => '{"done":true}', "ai_output_missing"],
    ["invalid JSON", (prompt: string): string => taggedOutput(prompt, "not json"), "ai_output_invalid"]
] as const)("OpenAIModel reports %s from official text output", async (_case, reply, code) => {
    // given an official text response that violates instructed-output framing
    const { loopy } = tempLoopy()
    const fake = fakeOpenAI(reply)
    const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

    // when the model is called
    const result = testRun(loopy, async () => model.call("check", { prompt: "Check.", output: outputSchema }))

    // then the shared instructed-output error is preserved
    await expect(result).rejects.toMatchObject({ code })
})

test("OpenAIModel preserves the prompt when the official client request fails", async () => {
    // given a fetch transport that fails beneath the official client
    const { loopy } = tempLoopy()
    const fake = fakeOpenAI(() => {
        throw new Error("connection lost")
    })
    const model = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })

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

test("OpenAIModel replay skips a second official client request", async () => {
    // given a persisted successful call through an official client
    const { loopy, reopen } = tempLoopy()
    const fake = fakeOpenAI((prompt) => taggedOutput(prompt, '{"done":true}'))
    const initialModel = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })
    const initialBody = () => initialModel.call("check", { prompt: "Check.", output: outputSchema })
    expect(await testRun(loopy, initialBody)).toEqual({ done: true })

    // when a fresh model replays the durable call
    const replayed = reopen()
    const replayedModel = new OpenAIModel({ model: "gpt-test", clientOptions: fake.clientOptions })
    const result = await testRun(replayed, () =>
        replayedModel.call("check", { prompt: "Check.", output: outputSchema })
    )

    // then stored output is returned without another fetch
    expect(result).toEqual({ done: true })
    expect(fake.requests).toHaveLength(1)
    expect(replayed.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 })
})

test.skipIf(!process.env.OPENAI_MODEL_LIVE_TEST)(
    "live: OpenAIModel returns a non-trivial instructed output",
    { timeout: 180_000 },
    async () => {
        // given a real OpenAI model using standard SDK environment credentials
        const { loopy } = tempLoopy()
        const model = new OpenAIModel({ model: "gpt-5.6-luna" })

        // when it is asked for an exact array-root discriminated union
        const result = await testRun(loopy, async () =>
            model.call("calculate", {
                prompt: `Calculate 6 * 7.

Answer with exactly two array entries in order: a calculation entry with expression "6 * 7" and value 42, then a status entry with done true. Omit the optional note.`,
                output: complexOutputSchema
            })
        )

        // then it returns the exact typed answer and a normalized reasoning event
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
        expect(messages.slice(1, -1).every((message) => message.role === "reasoning")).toBe(true)
        expect(messages.at(-1)!.role).toBe("assistant")
    }
)
