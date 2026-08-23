import * as z from "zod"
import { expect, test } from "vitest"
import { prepareInstructedOutput } from "@clankhouse/core/ai/instructed-output"
import { instructedSchema, instructedTags } from "@clankhouse/test-utils"

const outputSchema = z.object({ done: z.boolean() })

test("instructed output uses unique nonce tags and renders the schema", () => {
    // given two prepared output instructions
    const first = prepareInstructedOutput("report", outputSchema, "coding-agent")
    const second = prepareInstructedOutput("report", outputSchema, "coding-agent")

    // when their output instructions are inspected
    const firstTags = instructedTags(first.prompt)
    const secondTags = instructedTags(second.prompt)

    // then each instruction has unique matching tags
    expect(firstTags).not.toEqual(secondTags)
    expect(firstTags.closing).toBe(`</${firstTags.name}>`)
    expect(secondTags.closing).toBe(`</${secondTags.name}>`)
    // and the same JSON schema is rendered in both prompts
    expect(instructedSchema(first.prompt)).toEqual(instructedSchema(second.prompt))
    expect(instructedSchema(first.prompt)).toEqual({
        type: "object",
        properties: { done: { type: "boolean" } },
        required: ["done"]
    })
})

test("LLM instructed output requests only a nonce-tagged JSON answer", () => {
    // given an LLM instructed output prompt
    const prepared = prepareInstructedOutput("answer the question", outputSchema, "llm")
    const { opening, closing } = instructedTags(prepared.prompt)

    // when the prompt is inspected
    // then it calls the output an answer rather than a report
    expect(prepared.prompt).toMatch(/^answer the question\n\nIMPORTANT — requested final answer:/)
    expect(prepared.prompt).not.toContain("final report")
    // and it asks for an otherwise empty final reply
    expect(prepared.prompt).toContain("between these exact nonce tags")
    expect(prepared.prompt).toContain(
        "Your entire final reply should contain only the opening nonce tag, the JSON answer, and the closing nonce tag."
    )
    // and extra text outside the nonces is still ignored by the collector
    expect(prepared.collect([`unrequested prefix\n${opening}\n{"done":true}\n${closing}\nunrequested suffix`])).toEqual(
        { done: true }
    )
})

test.each(["coding-agent", "llm"] as const)(
    "z.string output in %s mode uses a simplified nonce prompt and collects raw text",
    (mode) => {
        // given a checked and branded root string schema in the selected AI mode
        const output = z.string().min(1).brand<"Answer">()
        const answer = '  "raw JSON-looking text"\n```text\nunchanged\n```  '

        // when instructed output is prepared and tagged text is collected
        const prepared = prepareInstructedOutput("answer naturally", output, mode)
        const { opening, closing } = instructedTags(prepared.prompt)
        const collected = prepared.collect([
            "An earlier untagged message.",
            `${opening}${answer}${closing}`,
            "A later untagged message."
        ])

        // then the dedicated prompt requests only a nonce-tagged final answer
        expect(prepared.prompt).toMatch(/^answer naturally\n\nIMPORTANT — requested final answer:/)
        expect(prepared.prompt).toContain("between these exact nonce tags")
        expect(prepared.prompt).toContain(`${opening}${closing}`)
        expect(prepared.prompt).toContain("Do not add framing whitespace")
        expect(prepared.prompt).toContain(
            "Your entire final reply should contain only the opening nonce tag, your answer, and the closing nonce tag."
        )
        expect(prepared.prompt).not.toMatch(/JSON/i)
        expect(prepared.prompt).not.toContain("final report")
        // and the latest tagged answer is returned as text without JSON or code-fence processing
        expect(collected).toBe(answer)
    }
)

test("z.string output preserves an empty tagged answer and rejects missing tags", () => {
    // given a direct string instruction and its exact nonce tags
    const prepared = prepareInstructedOutput("answer", z.string(), "llm")
    const { opening, closing } = instructedTags(prepared.prompt)

    // when an empty block or no complete block is collected
    const empty = prepared.collect([`${opening}${closing}`])
    const missing = () => prepared.collect(["plain answer", `${opening}unfinished`])

    // then the empty string remains a valid collected value and missing framing is distinct
    expect(empty).toBe("")
    expect(missing).toThrow(expect.objectContaining({ code: "ai_output_missing" }))
})

test.each([
    ["readonly", z.string().readonly()],
    ["pipe", z.string().pipe(z.string().min(1))],
    ["transform", z.string().transform((value) => value.length)]
] as const)("wrapped string output using %s retains instructed JSON framing", (_name, output) => {
    // given a string-input schema wrapped in another Zod type
    const prepared = prepareInstructedOutput("answer", output, "llm")
    const { opening, closing } = instructedTags(prepared.prompt)

    // when its prompt and collected output are inspected
    // then the wrapper prevents the root-string fast path
    expect(prepared.prompt).toMatch(/^answer\n\nIMPORTANT — requested final answer:/)
    expect(prepared.collect([`${opening}\n"value"\n${closing}`])).toBe("value")
})

test("instructed output for z.void leaves the prompt untouched and collects nothing", () => {
    // given prepared instructions for a void output in both modes
    const codingAgent = prepareInstructedOutput("report", z.void(), "coding-agent")
    const llm = prepareInstructedOutput("answer", z.void(), "llm")

    // when their prompts and final messages are inspected
    // then no output framing is appended and nothing is collected
    expect(codingAgent.prompt).toBe("report")
    expect(codingAgent.collect(["any final message"])).toBeUndefined()
    expect(codingAgent.collect([])).toBeUndefined()
    // and rejecting a void LLM output is left to the durable step that owns the policy
    expect(llm.prompt).toBe("answer")
    expect(llm.collect(["any final message"])).toBeUndefined()
})

test("instructed output collects the last complete nonce block across assistant messages", () => {
    // given assistant messages containing two complete reports followed by an incomplete attempt
    const prepared = prepareInstructedOutput("report", outputSchema, "coding-agent")
    const { opening, closing } = instructedTags(prepared.prompt)
    const assistantMessages = [
        `Here is an earlier attempt:\n${opening}\n{"done":false}\n${closing}`,
        "Working on a correction.",
        `${opening}\n{"done":true}\n${closing}`,
        "The monitor resolved without changing the report.",
        `${opening}\nunfinished`
    ]

    // when all assistant messages are collected
    const output = prepared.collect(assistantMessages)

    // then only the last complete matching report is parsed
    expect(output).toEqual({ done: true })
})

test("instructed output rejects missing or mismatched tags", () => {
    // given a prepared output instruction
    const prepared = prepareInstructedOutput("report", outputSchema, "coding-agent")
    const { opening } = instructedTags(prepared.prompt)

    // when final messages omit part or all of the instructed framing
    const collectMissingMessage = () => prepared.collect([])
    const collectMissingTags = () => prepared.collect(['{"done":true}'])
    const collectMismatchedTags = () => prepared.collect([`${opening}{"done":true}</different_tag>`])

    // then every framing failure is rejected distinctly from JSON parsing
    expect(collectMissingMessage).toThrow("did not return the instructed output tags")
    expect(collectMissingTags).toThrow("did not return the instructed output tags")
    expect(collectMismatchedTags).toThrow("did not return the instructed output tags")
    expect(collectMissingMessage).toThrow(expect.objectContaining({ code: "ai_output_missing" }))
    expect(collectMissingTags).toThrow(expect.objectContaining({ code: "ai_output_missing" }))
    expect(collectMismatchedTags).toThrow(expect.objectContaining({ code: "ai_output_missing" }))
})

test.each(["", "not json"])("instructed output selects a final %s block before JSON parsing", (payload) => {
    // given a valid JSON report followed by a complete nonce block containing the selected payload
    const prepared = prepareInstructedOutput("report", outputSchema, "coding-agent")
    const { opening, closing } = instructedTags(prepared.prompt)
    const assistantMessages = [`${opening}\n{"done":true}\n${closing}`, `${opening}\n${payload}\n${closing}`]

    // when all assistant messages are collected
    const collect = () => prepared.collect(assistantMessages)

    // then the last XML-like block wins without falling back to the earlier parseable block
    expect(collect).toThrow("returned invalid JSON between the instructed output tags")
    expect(collect).toThrow(expect.objectContaining({ code: "ai_output_invalid" }))
})

test("instructed output tolerates a markdown code fence around the tagged JSON", () => {
    // given an instruction and final messages whose tagged JSON is wrapped in a code fence
    const prepared = prepareInstructedOutput("report", outputSchema, "coding-agent")
    const { opening, closing } = instructedTags(prepared.prompt)
    const jsonFence = `${opening}\n\`\`\`json\n{"done":true}\n\`\`\`\n${closing}`
    const bareFence = `${opening}\n\`\`\`\n{"done":false}\n\`\`\`\n${closing}`

    // when the fenced messages are collected
    // then the fence is stripped and the JSON inside is parsed
    expect(prepared.collect([jsonFence])).toEqual({ done: true })
    expect(prepared.collect([bareFence])).toEqual({ done: false })
})

test("LLM instructed output reports shared AI framing and JSON errors", () => {
    // given an LLM instructed output prompt
    const prepared = prepareInstructedOutput("answer", outputSchema, "llm")
    const { opening, closing } = instructedTags(prepared.prompt)

    // when the reply omits the nonce tags or contains invalid JSON
    const missing = () => prepared.collect(['{"done":true}'])
    const invalid = () => prepared.collect([`${opening}\nnot json\n${closing}`])

    // then the errors identify the AI output failure
    expect(missing).toThrow("AI did not return the instructed output tags")
    expect(missing).toThrow(expect.objectContaining({ code: "ai_output_missing" }))
    expect(invalid).toThrow("AI returned invalid JSON between the instructed output tags")
    expect(invalid).toThrow(expect.objectContaining({ code: "ai_output_invalid" }))
})

test("instructed output rejects a schema that cannot be represented as JSON", () => {
    // given a non-JSON-compatible output schema in each mode
    const codingAgent = () => prepareInstructedOutput("report", z.date(), "coding-agent")
    const llm = () => prepareInstructedOutput("answer", z.date(), "llm")

    // when the output instructions are prepared
    // then both are rejected before any framing is built
    expect(codingAgent).toThrow(/Instructed output schema.*z\.date\(\)/)
    expect(llm).toThrow(/Instructed output schema.*z\.date\(\)/)
    expect(codingAgent).toThrow(expect.objectContaining({ code: "schema_not_json_compatible" }))
    expect(llm).toThrow(expect.objectContaining({ code: "schema_not_json_compatible" }))
})
