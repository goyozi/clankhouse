import type { ClientOptions } from "openai"
import type {
    Response as OpenAIResponse,
    ResponseCreateParamsNonStreaming,
    ResponseOutputItem
} from "openai/resources/responses/responses"

export type FakeOpenAIResponse = OpenAIResponse

export function fakeOpenAI(
    respond: (prompt: string) => string | FakeOpenAIResponse | Promise<string | FakeOpenAIResponse>
): {
    clientOptions: ClientOptions
    requests: ResponseCreateParamsNonStreaming[]
    urls: string[]
} {
    const requests: ResponseCreateParamsNonStreaming[] = []
    const urls: string[] = []
    return {
        requests,
        urls,
        clientOptions: {
            apiKey: "test-key",
            maxRetries: 0,
            async fetch(input, init) {
                urls.push(String(input))
                const request = JSON.parse(String(init?.body)) as ResponseCreateParamsNonStreaming
                requests.push(request)
                if (typeof request.input !== "string") throw new Error("fakeOpenAI supports only string inputs")
                const response = await respond(request.input)
                return Response.json(
                    typeof response === "string" ? openAIResponse([outputMessage(response)]) : response
                )
            }
        }
    }
}

export function openAIResponse(
    output: ResponseOutputItem[],
    overrides: Partial<Omit<OpenAIResponse, "output">> = {}
): OpenAIResponse {
    return {
        id: "resp_test",
        created_at: 0,
        output_text: "",
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        model: "gpt-test",
        object: "response",
        output,
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
        status: "completed",
        ...overrides
    }
}

export function outputMessage(text: string): Extract<ResponseOutputItem, { type: "message" }> {
    return {
        id: "msg_test",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }]
    }
}

export function reasoningItem(text: string): Extract<ResponseOutputItem, { type: "reasoning" }> {
    return {
        id: "reasoning_test",
        type: "reasoning",
        summary: text === "" ? [] : [{ type: "summary_text", text }]
    }
}
