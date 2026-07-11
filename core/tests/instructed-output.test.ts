import * as z from "zod"
import { expect, test } from "vitest"
import { prepareInstructedOutput } from "@loopy/core/ai/instructed-output"
import { instructedSchema, instructedTags } from "@loopy/test-utils"

const outputSchema = z.object({ done: z.boolean() })

test("instructed output uses unique nonce tags and renders the schema", () => {
    // given two prepared output instructions
    const first = prepareInstructedOutput("report", outputSchema)
    const second = prepareInstructedOutput("report", outputSchema)

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
        required: ["done"],
        additionalProperties: false
    })
})

test("instructed output for z.void leaves the prompt untouched and collects nothing", () => {
    // given a prepared output instruction for a void output
    const prepared = prepareInstructedOutput("report", z.void())

    // when the prompt and a final message are inspected
    // then no output framing is appended and nothing is collected
    expect(prepared.prompt).toBe("report")
    expect(prepared.collect("any final message")).toBeUndefined()
    expect(prepared.collect()).toBeUndefined()
})

test("instructed output collects the last tagged JSON document amid prose", () => {
    // given an instruction and a final message containing two tagged reports and surrounding prose
    const prepared = prepareInstructedOutput("report", outputSchema)
    const { opening, closing } = instructedTags(prepared.prompt)
    const finalMessage = `Here is an earlier attempt:
${opening}
{"done":false}
${closing}
The corrected result follows.
${opening}
{"done":true}
${closing}
Thanks.`

    // when the final message is collected
    const output = prepared.collect(finalMessage)

    // then only the last complete matching report is parsed
    expect(output).toEqual({ done: true })
})

test("instructed output rejects missing or mismatched tags", () => {
    // given a prepared output instruction
    const prepared = prepareInstructedOutput("report", outputSchema)
    const { opening } = instructedTags(prepared.prompt)

    // when final messages omit part or all of the instructed framing
    const collectMissingMessage = () => prepared.collect()
    const collectMissingTags = () => prepared.collect('{"done":true}')
    const collectMismatchedTags = () => prepared.collect(`${opening}{"done":true}</different_tag>`)

    // then every framing failure is rejected distinctly from JSON parsing
    expect(collectMissingMessage).toThrow("did not return the instructed output tags")
    expect(collectMissingTags).toThrow("did not return the instructed output tags")
    expect(collectMismatchedTags).toThrow("did not return the instructed output tags")
})

test("instructed output rejects empty or non-JSON tag contents", () => {
    // given a prepared output instruction and its exact nonce tags
    const prepared = prepareInstructedOutput("report", outputSchema)
    const { opening, closing } = instructedTags(prepared.prompt)

    // when the tag contents are empty or not raw JSON
    const collectEmpty = () => prepared.collect(`${opening}\n\n${closing}`)
    const collectInvalid = () => prepared.collect(`${opening}\nnot json\n${closing}`)

    // then each payload is rejected as invalid JSON
    expect(collectEmpty).toThrow("returned invalid JSON between the instructed output tags")
    expect(collectInvalid).toThrow("returned invalid JSON between the instructed output tags")
})

test("instructed output tolerates a markdown code fence around the tagged JSON", () => {
    // given an instruction and final messages whose tagged JSON is wrapped in a code fence
    const prepared = prepareInstructedOutput("report", outputSchema)
    const { opening, closing } = instructedTags(prepared.prompt)
    const jsonFence = `${opening}\n\`\`\`json\n{"done":true}\n\`\`\`\n${closing}`
    const bareFence = `${opening}\n\`\`\`\n{"done":false}\n\`\`\`\n${closing}`

    // when the fenced messages are collected
    // then the fence is stripped and the JSON inside is parsed
    expect(prepared.collect(jsonFence)).toEqual({ done: true })
    expect(prepared.collect(bareFence)).toEqual({ done: false })
})

test("instructed output ignores an echoed empty tag template after the answer", () => {
    // given a final message whose real answer is followed by the empty tag template from the prompt
    const prepared = prepareInstructedOutput("report", outputSchema)
    const { opening, closing } = instructedTags(prepared.prompt)
    const finalMessage = `${opening}\n{"done":true}\n${closing}\n\nAs requested, used:\n${opening}\n${closing}`

    // when the final message is collected
    const output = prepared.collect(finalMessage)

    // then the trailing empty template is skipped and the real answer is parsed
    expect(output).toEqual({ done: true })
})
