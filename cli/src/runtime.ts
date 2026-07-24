import { type DescMessage, type MessageShape } from "@bufbuild/protobuf"
import type { Command } from "commander"
import { connect, type LoopyClient } from "./client"
import { publicError } from "./errors"
import { Output, type ErrorOutputOptions, writeErrorOutput } from "./output"

export type RuntimeOptions = {
    stdin: NodeJS.ReadableStream
    stdout: NodeJS.WritableStream
    stderr: NodeJS.WritableStream
    env: NodeJS.ProcessEnv
    cwd: string
    signal: AbortSignal
}

type GlobalOptions = {
    server?: string
    apiKey?: string
    json?: boolean
}

export class Runtime {
    private cachedClient: LoopyClient | undefined
    private resultCode = 0
    private pendingOutput: Promise<void> = Promise.resolve()

    constructor(private readonly options: RuntimeOptions) {}

    get exitCode(): number {
        return this.resultCode
    }

    failResult(): void {
        this.resultCode = 1
    }

    enqueueOutput(write: () => Promise<void>): void {
        this.pendingOutput = this.pendingOutput.then(write)
    }

    async drainOutput(): Promise<void> {
        const pending = this.pendingOutput
        this.pendingOutput = Promise.resolve()
        await pending
    }

    async reportError(command: Command, error: unknown, options?: ErrorOutputOptions): Promise<void> {
        this.failResult()
        await writeErrorOutput(this.options.stderr, publicError(error), this.output(command).json, options)
    }

    output(command: Command): Output {
        return new Output(this.options.stdout, command.optsWithGlobals<GlobalOptions>().json === true)
    }

    async client(command: Command): Promise<LoopyClient> {
        const global = command.optsWithGlobals<GlobalOptions>()
        return (this.cachedClient ??= await connect({
            ...(global.server !== undefined ? { server: global.server } : {}),
            ...(global.apiKey !== undefined ? { apiKey: global.apiKey } : {}),
            env: this.options.env
        }))
    }

    async emit<Desc extends DescMessage>(
        command: Command,
        schema: Desc,
        message: MessageShape<Desc>,
        human: () => string
    ): Promise<void> {
        const output = this.output(command)
        if (output.json) await output.proto(schema, message)
        else await output.write(human())
    }

    get stdin(): NodeJS.ReadableStream {
        return this.options.stdin
    }

    get stdout(): NodeJS.WritableStream {
        return this.options.stdout
    }

    get stderr(): NodeJS.WritableStream {
        return this.options.stderr
    }

    get cwd(): string {
        return this.options.cwd
    }

    get signal(): AbortSignal {
        return this.options.signal
    }
}
