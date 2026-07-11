import { randomUUID } from "node:crypto"
import * as z from "zod"

export type PreparedInstructedOutput = {
    prompt: string
    collect(finalMessage?: string): unknown
}

export function prepareInstructedOutput(prompt: string, output: z.ZodTypeAny): PreparedInstructedOutput {
    if (output instanceof z.ZodVoid) {
        return { prompt, collect: () => undefined }
    }
    const jsonSchema = z.toJSONSchema(output)
    delete jsonSchema.$schema
    const tagName = `loopy_structured_output_${randomUUID().replaceAll("-", "_")}`
    const openingTag = `<${tagName}>`
    const closingTag = `</${tagName}>`
    return {
        prompt: `${prompt}\n\nIMPORTANT — requested final report:

When you are done, put a final JSON report between these exact tags in your final response:

${openingTag}
${closingTag}

The JSON must conform to this JSON Schema:

\`\`\`json
${JSON.stringify(jsonSchema, null, 2)}
\`\`\`
Write only raw JSON between the tags — no markdown fences, no comments, no surrounding prose.
You may include prose outside the tags.`,
        collect(finalMessage) {
            const text = extractTaggedOutput(finalMessage, openingTag, closingTag)
            return parseJson(
                stripCodeFence(text),
                "Coding agent returned invalid JSON between the instructed output tags"
            )
        }
    }
}

function extractTaggedOutput(finalMessage: string | undefined, openingTag: string, closingTag: string): string {
    if (finalMessage === undefined) {
        throw new Error("Coding agent did not return the instructed output tags in its final response")
    }
    const blocks = tagBlocks(finalMessage, openingTag, closingTag)
    if (blocks.length === 0) {
        throw new Error("Coding agent did not return the instructed output tags in its final response")
    }
    return blocks.findLast((block) => block !== "") ?? blocks[blocks.length - 1]
}

function tagBlocks(finalMessage: string, openingTag: string, closingTag: string): string[] {
    const blocks: string[] = []
    let from = 0
    while (true) {
        const openingIndex = finalMessage.indexOf(openingTag, from)
        if (openingIndex === -1) break
        const closingIndex = finalMessage.indexOf(closingTag, openingIndex + openingTag.length)
        if (closingIndex === -1) break
        blocks.push(finalMessage.slice(openingIndex + openingTag.length, closingIndex).trim())
        from = closingIndex + closingTag.length
    }
    return blocks
}

function stripCodeFence(text: string): string {
    const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
    return fenced === null ? text : fenced[1].trim()
}

function parseJson(text: string, message: string): unknown {
    try {
        return JSON.parse(text)
    } catch (error) {
        throw new Error(message, { cause: error })
    }
}
