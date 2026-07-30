import type { ClientOptions } from "@anthropic-ai/sdk"
import type {
    ContentBlock,
    Message,
    MessageCreateParamsStreaming,
    MessageStreamEvent,
    StopReason
} from "@anthropic-ai/sdk/resources/messages"

export type FakeAnthropicResponse = {
    content: ContentBlock[]
    stopReason: StopReason
}

export function fakeAnthropic(
    respond: (
        prompt: string
    ) => ContentBlock[] | FakeAnthropicResponse | Promise<ContentBlock[] | FakeAnthropicResponse>
): {
    clientOptions: ClientOptions
    requests: MessageCreateParamsStreaming[]
} {
    const requests: MessageCreateParamsStreaming[] = []
    return {
        requests,
        clientOptions: {
            apiKey: "test-key",
            maxRetries: 0,
            async fetch(_input, init) {
                const request = JSON.parse(String(init?.body)) as MessageCreateParamsStreaming
                requests.push(request)
                const firstMessage = request.messages[0]
                if (typeof firstMessage?.content !== "string") {
                    throw new Error("fakeAnthropic supports only one string prompt")
                }
                const response = await respond(firstMessage.content)
                const message = anthropicMessage(
                    request.model,
                    Array.isArray(response) ? response : response.content,
                    Array.isArray(response) ? "end_turn" : response.stopReason
                )
                return new Response(toSSE(message), {
                    headers: {
                        "content-type": "text/event-stream",
                        "request-id": "req_test"
                    }
                })
            }
        }
    }
}

function anthropicMessage(model: string, content: ContentBlock[], stopReason: StopReason): Message {
    return {
        id: "msg_test",
        container: null,
        content,
        model,
        role: "assistant",
        stop_details: null,
        stop_reason: stopReason,
        stop_sequence: null,
        type: "message",
        usage: {
            cache_creation: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            inference_geo: null,
            input_tokens: 1,
            output_tokens: 1,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: "standard"
        }
    }
}

function toSSE(message: Message): string {
    const events: MessageStreamEvent[] = [
        {
            type: "message_start",
            message: {
                ...message,
                content: [],
                stop_reason: null,
                usage: { ...message.usage, output_tokens: 0 }
            }
        },
        ...message.content.flatMap((contentBlock, index): MessageStreamEvent[] => [
            { type: "content_block_start", index, content_block: contentBlock },
            { type: "content_block_stop", index }
        ]),
        {
            type: "message_delta",
            delta: {
                container: message.container,
                stop_details: message.stop_details,
                stop_reason: message.stop_reason,
                stop_sequence: message.stop_sequence
            },
            usage: {
                cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
                cache_read_input_tokens: message.usage.cache_read_input_tokens,
                input_tokens: message.usage.input_tokens,
                output_tokens: message.usage.output_tokens,
                output_tokens_details: message.usage.output_tokens_details,
                server_tool_use: message.usage.server_tool_use
            }
        },
        { type: "message_stop" }
    ]
    return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

export function textBlock(text: string): Extract<ContentBlock, { type: "text" }> {
    return { type: "text", text, citations: null }
}

export function thinkingBlock(thinking: string): Extract<ContentBlock, { type: "thinking" }> {
    return { type: "thinking", thinking, signature: "test-signature" }
}

export function redactedThinkingBlock(data: string): Extract<ContentBlock, { type: "redacted_thinking" }> {
    return { type: "redacted_thinking", data }
}
