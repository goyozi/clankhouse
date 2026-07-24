import { CommanderError, Command } from "commander"
import { registerArtifacts } from "./cmd/artifacts"
import { registerEvents } from "./cmd/events"
import { registerRuns } from "./cmd/runs"
import { registerSessions } from "./cmd/sessions"
import { registerWorkflows } from "./cmd/workflows"
import { publicError } from "./errors"
import { isBrokenPipe, writeText } from "./io"
import { writeErrorOutput } from "./output"
import { Runtime } from "./runtime"

export type CliOptions = {
    stdin?: NodeJS.ReadableStream
    stdout?: NodeJS.WritableStream
    stderr?: NodeJS.WritableStream
    env?: NodeJS.ProcessEnv
    cwd?: string
    signal?: AbortSignal
}

export async function runCli(args: readonly string[], options: CliOptions = {}): Promise<number> {
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })

    const streams = {
        stdin: options.stdin ?? process.stdin,
        stdout: options.stdout ?? process.stdout,
        stderr: options.stderr ?? process.stderr,
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        signal: controller.signal
    }
    const runtime = new Runtime(streams)
    const program = createProgram(runtime)

    try {
        try {
            await program.parseAsync([...args], { from: "user" })
            await runtime.drainOutput()
            if (streams.signal.aborted) return 130
            return runtime.exitCode
        } catch (error) {
            if (isBrokenPipe(error)) throw error
            if (streams.signal.aborted) return 130
            await runtime.drainOutput()
            const json = runtime.output(program).json
            if (error instanceof CommanderError) {
                if (error.code === "commander.helpDisplayed") return 0
                if (json) {
                    await writeErrorOutput(
                        streams.stderr,
                        { code: "usage", message: cleanCommanderMessage(error.message) },
                        true
                    )
                }
                return 2
            }
            await writeErrorOutput(streams.stderr, publicError(error), json)
            return 1
        }
    } catch (error) {
        if (!isBrokenPipe(error)) throw error
        controller.abort(error)
        return 0
    } finally {
        options.signal?.removeEventListener("abort", abort)
        controller.abort()
    }
}

function createProgram(runtime: Runtime): Command {
    const program = new Command()
        .name("loopy")
        .description("Interact with a Loopy server")
        .option("--server <url>", "Loopy server URL")
        .option("--api-key <key>", "Loopy server API key")
        .option("--json", "print protobuf responses as ProtoJSON")
        .exitOverride()
        .showHelpAfterError()
        .configureOutput({
            writeOut: (value) => runtime.enqueueOutput(() => runtime.output(program).write(value)),
            writeErr: (value) => {
                if (!runtime.output(program).json) {
                    runtime.enqueueOutput(() => writeText(runtime.stderr, value))
                }
            }
        })

    registerWorkflows(program, runtime)
    registerRuns(program, runtime)
    registerEvents(program, runtime)
    registerArtifacts(program, runtime)
    registerSessions(program, runtime)

    return program
}

function cleanCommanderMessage(message: string): string {
    return message.replace(/^error:\s*/, "")
}
