import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { FakeLLM } from "@clankhouse/core/ai/fake-llm"
import { ClankHouse } from "@clankhouse/core/clankhouse"
import { gate, tempDir, tempClankHouse, testRun } from "@clankhouse/test-utils"

const outputSchema = z.object({ summary: z.string() })

test("FakeLLM performs a durable llm step with a persisted session", async () => {
    // given a fake llm that counts invocations and returns a formatted summary
    const { clankhouse } = tempClankHouse()
    let invocations = 0
    const llm = new FakeLLM((stepName, prompt) => {
        invocations++
        return { summary: `${stepName}: ${prompt}` }
    })

    // when the llm is called inside a durable step
    const result = await testRun(clankhouse, async () =>
        llm.call("summarize", { prompt: "hello world", output: outputSchema })
    )

    // then it returns the formatted summary
    expect(result).toEqual({ summary: "summarize: hello world" })
    // and the model is invoked exactly once
    expect(invocations).toBe(1)
    // and the run records an llm step
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.kind).toBe("llm")
    if (step.kind !== "llm") throw new Error("unreachable")
    // and the session is persisted with client, provider and model info
    const session = await clankhouse.sessions.get(step.sessionId!)
    expect(session.kind).toBe("llm")
    expect(session.client).toBe("fake-llm")
    expect(session.provider).toBe("fake")
    expect(session.model).toBe("fake")
    expect(session.status).toBe("succeeded")
    // and the session messages contain the prompt and the response
    expect(
        session.messages.map((item) => [
            item.type === "message" ? item.role : item.type,
            item.type === "message" ? item.content : null
        ])
    ).toEqual([
        ["user", "hello world"],
        ["assistant", JSON.stringify({ summary: "summarize: hello world" })]
    ])
})

test("llm output is validated against the output schema and fails the session", async () => {
    // given a fake llm that returns output not matching the output schema
    const { clankhouse } = tempClankHouse()
    const llm = new FakeLLM(() => ({ wrong: true }))

    // when the llm is called inside a durable step
    // then it throws a validation error
    await expect(
        testRun(clankhouse, async () => llm.call("summarize", { prompt: "p", output: outputSchema }))
    ).rejects.toThrow()
    // and the step is marked as failed
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "llm") throw new Error("unreachable")
    // and the session is marked as failed
    const session = await clankhouse.sessions.get(step.sessionId!)
    expect(session.status).toBe("failed")
})

test("llm output is validated exactly once per call", async () => {
    // given an output schema that counts how many times it validates a value
    const { clankhouse } = tempClankHouse()
    let validations = 0
    const counting = outputSchema.superRefine(() => {
        validations++
    })
    const llm = new FakeLLM(() => ({ summary: "s" }))

    // when the llm is called inside a durable step
    await testRun(clankhouse, async () => llm.call("summarize", { prompt: "p", output: counting }))

    // then the output schema validates the result only once, not once per redundant parse
    expect(validations).toBe(1)
})

test("an invalid LLM reply schema fails before steps, sessions, or provider calls", async () => {
    // given a fake LLM and a non-JSON reply schema
    const { clankhouse } = tempClankHouse()
    let invocations = 0
    const llm = new FakeLLM(() => {
        invocations++
        return new Date()
    })

    // when the LLM call is set up
    const promise = testRun(clankhouse, async () => llm.call("stamp", { prompt: "p", output: z.date() }))

    // then the guard fails before any durable or provider side effect
    await expect(promise).rejects.toThrow(/LLM "stamp" output schema.*z\.date/)
    expect(invocations).toBe(0)
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM steps").get()).toEqual({ n: 0 })
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 })
})

test("a void LLM reply schema fails before steps, sessions, or provider calls", async () => {
    // given a fake LLM that counts invocations
    const { clankhouse } = tempClankHouse()
    let invocations = 0
    const llm = new FakeLLM(() => {
        invocations++
    })

    // when the LLM call is set up with a void reply
    const promise = testRun(clankhouse, async () => llm.call("notify", { prompt: "p", output: z.void() }), {
        output: z.void()
    })

    // then the guard fails before any durable or provider side effect
    await expect(promise).rejects.toThrow(/LLM "notify" output schema.*z\.void/)
    expect(invocations).toBe(0)
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM steps").get()).toEqual({ n: 0 })
    expect(clankhouse.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 })
})

test("replay skips the model invocation", async () => {
    // given a reopenable clankhouse instance and a fake llm counting invocations
    const { clankhouse, reopen } = tempClankHouse()
    let invocations = 0
    let transforms = 0
    const llm = new FakeLLM(() => {
        invocations++
        return { summary: "s" }
    })
    const replySchema = outputSchema.transform((value) => {
        transforms++
        return { summary: `${value.summary}!` }
    })
    // and gates to coordinate when the run has reached the llm call and when it may finish
    const parked = gate()
    const reached = gate()
    // and a workflow body that calls the llm, signals it was reached, then optionally blocks
    const body = (l: ClankHouse, block: boolean) => async () => {
        const summary = await llm.call("summarize", { prompt: "p", output: replySchema })
        reached.release()
        if (block) await parked.released
        return summary
    }

    // when the first run starts and blocks right after the llm call
    testRun(clankhouse, body(clankhouse, true)).catch(() => {})
    // and it reaches the llm call
    await reached.released

    // when the clankhouse instance is reopened and the run replayed to completion
    const second = reopen()
    // then the replayed run transforms the stored raw reply once and returns the same result
    expect(await testRun(second, body(second, false))).toEqual({ summary: "s!" })
    expect(transforms).toBe(2)
    // and the model is not invoked again during replay
    expect(invocations).toBe(1)
    // and the step stores ordinary provider JSON rather than the transformed result
    const run = await second.runs.get((await second.runs.list())[0].id)
    expect(run.steps[0].outputJson).toBe(JSON.stringify({ summary: "s" }))
    // and only one session was persisted across both runs
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 })
})

test("file prompts are rendered with Handlebars", async () => {
    // given a prompt file containing a Handlebars template
    const { clankhouse } = tempClankHouse()
    const promptFile = path.join(tempDir("clankhouse-prompt-"), "prompt.hbs")
    fs.writeFileSync(promptFile, "Hello {{name}}!")
    // and a fake llm that records the rendered prompt it receives
    const prompts: string[] = []
    const llm = new FakeLLM((_stepName, prompt) => {
        prompts.push(prompt)
        return { summary: "s" }
    })

    // when the llm is called with a file prompt and template variables
    await testRun(clankhouse, async () =>
        llm.call("summarize", {
            prompt: { file: promptFile, vars: { name: "World" } },
            output: outputSchema
        })
    )

    // then the prompt is rendered with the variable substituted
    expect(prompts).toEqual(["Hello World!"])
})

test("llm call outside a workflow run is rejected", async () => {
    // given a clankhouse instance with no active workflow run
    tempClankHouse()
    const llm = new FakeLLM(() => ({ summary: "s" }))

    // when calling the llm outside a durable run
    // then it rejects with an error about running inside a workflow run
    await expect(llm.call("summarize", { prompt: "p", output: outputSchema })).rejects.toThrow(/inside a workflow run/)
})
