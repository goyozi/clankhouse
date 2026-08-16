import { GetSessionResponseSchema, WatchSessionResponseSchema } from "@loopy/server/proto"
import type { Command } from "commander"
import type { Runtime } from "../../runtime"
import { formatSession, formatSessionMessageLines, formatSessionWatchHeader } from "./output"

export function registerSessions(program: Command, runtime: Runtime): void {
    const sessions = program.command("sessions").description("Inspect AI sessions")
    sessions
        .command("get")
        .description("Get an AI session")
        .argument("<session-id>")
        .action(async (sessionId: string, _options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.getSession({ sessionId }, { signal: runtime.signal })
            await runtime.emit(command, GetSessionResponseSchema, response, () => formatSession(response))
        })
    sessions
        .command("watch")
        .description("Watch AI session messages")
        .argument("<session-id>")
        .action(async (sessionId: string, _options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const output = runtime.output(command)
            if (!output.json) {
                const response = await client.getSession({ sessionId }, { signal: runtime.signal })
                await output.write(formatSessionWatchHeader(response))
            }
            for await (const response of client.watchSession({ sessionId }, { signal: runtime.signal })) {
                if (output.json) await output.proto(WatchSessionResponseSchema, response)
                else if (response.message !== undefined) await output.write(formatSessionMessageLines(response.message))
            }
        })
}
