import { EmitEventResponseSchema } from "@loopy/server/proto"
import type { Command } from "commander"
import { readJsonInput } from "../io"
import type { Runtime } from "../runtime"

export function registerEvents(program: Command, runtime: Runtime): void {
    const events = program.command("events").description("Emit workflow events")
    events
        .command("emit")
        .description("Emit an event")
        .argument("<key>")
        .requiredOption("--input <file|->", "JSON input file, or - for stdin")
        .action(async (key: string, options: { input: string }, command: Command) => {
            const inputJson = await readJsonInput(options.input, runtime.cwd, runtime.stdin, runtime.signal)
            const client = await runtime.client(command)
            const response = await client.emitEvent({ key, inputJson }, { signal: runtime.signal })
            await runtime.emit(command, EmitEventResponseSchema, response, () => `Event emitted: ${key}\n`)
        })
}
