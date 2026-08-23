import { randomUUID } from "node:crypto"
import * as z from "zod"
import { ClankHouseError } from "../errors"
import { jsonSchema } from "../json-schema"

export type InstructedOutputMode = "coding-agent" | "llm"

export type PreparedInstructedOutput = {
    prompt: string
    collect(assistantMessages: readonly string[]): unknown
}

export function prepareInstructedOutput(
    prompt: string,
    output: z.ZodTypeAny,
    mode: InstructedOutputMode
): PreparedInstructedOutput {
    if (output instanceof z.ZodString) {
        const { openingTag, closingTag } = nonceTags()
        return {
            prompt: stringInstruction(prompt, openingTag, closingTag),
            collect: (assistantMessages) => extractTaggedOutput(assistantMessages, openingTag, closingTag)
        }
    }
    const instructedSchema = jsonSchema({
        schema: output,
        io: "input",
        role: "Instructed output schema",
        allowTopLevelVoid: true
    })
    if (instructedSchema === undefined) return { prompt, collect: () => undefined }
    const { openingTag, closingTag } = nonceTags()
    const instruction = mode === "llm" ? languageModelInstruction : codingAgentInstruction
    return {
        prompt: instruction(prompt, openingTag, closingTag, instructedSchema),
        collect(assistantMessages) {
            const text = extractTaggedOutput(assistantMessages, openingTag, closingTag).trim()
            return parseJson(stripCodeFence(text))
        }
    }
}

function nonceTags(): { openingTag: string; closingTag: string } {
    const tagName = `clankhouse_structured_output_${randomUUID().replaceAll("-", "_")}`
    return { openingTag: `<${tagName}>`, closingTag: `</${tagName}>` }
}

function stringInstruction(prompt: string, openingTag: string, closingTag: string): string {
    return `${prompt}\n\nIMPORTANT — requested final answer:

Put your answer between these exact nonce tags in your final reply:

${openingTag}${closingTag}

Do not add framing whitespace: put your answer immediately after the opening nonce tag and put the closing nonce tag immediately after your answer.
Your entire final reply should contain only the opening nonce tag, your answer, and the closing nonce tag. Do not include any other text.`
}

function codingAgentInstruction(prompt: string, openingTag: string, closingTag: string, schema: unknown): string {
    return `${prompt}\n\nIMPORTANT — requested final report:

When you are done, put a final JSON report between these exact tags in your final response:

${openingTag}
${closingTag}

The JSON must conform to this JSON Schema:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`
Write only raw JSON between the tags — no markdown fences, no comments, no surrounding prose.
You may include prose outside the tags.`
}

function languageModelInstruction(prompt: string, openingTag: string, closingTag: string, schema: unknown): string {
    return `${prompt}\n\nIMPORTANT — requested final answer:

Put your JSON answer between these exact nonce tags in your final reply:

${openingTag}
${closingTag}

The JSON must conform to this JSON Schema:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`
Write only raw JSON between the nonce tags — no markdown fences, no comments, no surrounding prose.
Your entire final reply should contain only the opening nonce tag, the JSON answer, and the closing nonce tag. Do not include any other text.`
}

function extractTaggedOutput(assistantMessages: readonly string[], openingTag: string, closingTag: string): string {
    const blocks = assistantMessages.flatMap((message) => tagBlocks(message, openingTag, closingTag))
    if (blocks.length === 0) {
        throw new ClankHouseError(
            "ai_output_missing",
            "AI did not return the instructed output tags in any assistant message"
        )
    }
    return blocks[blocks.length - 1]
}

function tagBlocks(finalMessage: string, openingTag: string, closingTag: string): string[] {
    const blocks: string[] = []
    let from = 0
    while (true) {
        const openingIndex = finalMessage.indexOf(openingTag, from)
        if (openingIndex === -1) break
        const closingIndex = finalMessage.indexOf(closingTag, openingIndex + openingTag.length)
        if (closingIndex === -1) break
        blocks.push(finalMessage.slice(openingIndex + openingTag.length, closingIndex))
        from = closingIndex + closingTag.length
    }
    return blocks
}

function stripCodeFence(text: string): string {
    const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
    return fenced === null ? text : fenced[1].trim()
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch (error) {
        throw new ClankHouseError("ai_output_invalid", "AI returned invalid JSON between the instructed output tags", {
            cause: error
        })
    }
}
