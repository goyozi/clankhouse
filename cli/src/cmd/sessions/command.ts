import { GetSessionResponseSchema, WatchSessionResponseSchema } from "@clankhouse/protocol"
import type { Command } from "commander"
import { collectIncludes, includes, type IncludeOptions } from "../../includes.js"
import type { Runtime } from "../../runtime.js"
import { formatSession, formatSessionMessageLines, formatSessionWatchHeader } from "./output.js"

type SessionInclude = "tool-io" | "all"
type SessionOptions = IncludeOptions<SessionInclude>

const sessionIncludes = ["tool-io", "all"] as const

export function registerSessions(program: Command, runtime: Runtime): void {
    const sessions = program.command("sessions").description("Inspect AI sessions")
    sessions
        .command("get")
        .description("Get an AI session")
        .argument("<session-id>")
        .option("--include <resource>", "include additional session details", collectIncludes(sessionIncludes), [])
        .action(async (sessionId: string, options: SessionOptions, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.getSession({ sessionId }, { signal: runtime.signal })
            const formatOptions = { includeToolIo: includes(options, command, "tool-io") }
            await runtime.emit(command, GetSessionResponseSchema, response, () =>
                formatSession(response, formatOptions)
            )
        })
    sessions
        .command("watch")
        .description("Watch AI session messages")
        .argument("<session-id>")
        .option("--include <resource>", "include additional session details", collectIncludes(sessionIncludes), [])
        .action(async (sessionId: string, options: SessionOptions, command: Command) => {
            const client = await runtime.client(command)
            const output = runtime.output(command)
            const formatOptions = { includeToolIo: includes(options, command, "tool-io") }
            if (!output.json) {
                const response = await client.getSession({ sessionId }, { signal: runtime.signal })
                await output.write(formatSessionWatchHeader(response))
            }
            for await (const response of client.watchSession({ sessionId }, { signal: runtime.signal })) {
                if (output.json) await output.proto(WatchSessionResponseSchema, response)
                else if (response.message !== undefined) {
                    await output.write(formatSessionMessageLines(response.message, formatOptions))
                }
            }
        })
}
