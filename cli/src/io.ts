import { randomBytes } from "node:crypto"
import { link, lstat, open, readFile, unlink, type FileHandle } from "node:fs/promises"
import * as path from "node:path"
import { CliError } from "./errors.js"

export async function writeText(stream: NodeJS.WritableStream, text: string): Promise<void> {
    await writeChunk(stream, text)
}

export async function writeBytes(stream: NodeJS.WritableStream, bytes: Uint8Array): Promise<void> {
    await writeChunk(stream, bytes)
}

export async function readJsonInput(
    input: string,
    cwd: string,
    stdin: NodeJS.ReadableStream,
    signal: AbortSignal
): Promise<string> {
    let text: string
    try {
        text =
            input === "-"
                ? await readStream(stdin, signal)
                : await readFile(path.resolve(cwd, input), { encoding: "utf8", signal })
    } catch (cause) {
        throw new CliError("input", `Unable to read JSON input from ${input}`, { cause })
    }
    try {
        JSON.parse(text)
    } catch (cause) {
        throw new CliError("input", `Input from ${input} is not valid JSON`, { cause })
    }
    return text
}

export async function copyWithoutClobber(destination: string, chunks: () => AsyncIterable<Uint8Array>): Promise<void> {
    try {
        await lstat(destination)
        throw new CliError("already_exists", `Destination already exists: ${destination}`)
    } catch (error) {
        if (error instanceof CliError) throw error
        if (!isNodeError(error, "ENOENT")) throw error
    }

    const temporary = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.clankhouse-${process.pid}-${randomBytes(8).toString("hex")}.tmp`
    )
    let handle: FileHandle | undefined
    try {
        handle = await open(temporary, "wx", 0o600)
        for await (const chunk of chunks()) await writeFileChunk(handle, chunk)
        await handle.sync()
        await handle.close()
        handle = undefined
        await link(temporary, destination)
    } catch (cause) {
        if (isNodeError(cause, "EEXIST")) {
            throw new CliError("already_exists", `Destination already exists: ${destination}`, { cause })
        }
        throw cause
    } finally {
        await handle?.close().catch(() => {})
        await unlink(temporary).catch(() => {})
    }
}

function readStream(stream: NodeJS.ReadableStream, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        const onData = (chunk: string | Buffer) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        const cleanup = () => {
            stream.off("data", onData)
            stream.off("end", onEnd)
            stream.off("error", onError)
            signal.removeEventListener("abort", onAbort)
        }
        const onEnd = () => {
            cleanup()
            resolve(Buffer.concat(chunks).toString("utf8"))
        }
        const onError = (error: Error) => {
            cleanup()
            reject(error)
        }
        const onAbort = () => {
            cleanup()
            stream.pause()
            reject(signal.reason)
        }

        if (signal.aborted) {
            onAbort()
            return
        }
        stream.on("data", onData)
        stream.once("end", onEnd)
        stream.once("error", onError)
        signal.addEventListener("abort", onAbort, { once: true })
    })
}

function writeChunk(stream: NodeJS.WritableStream, chunk: string | Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => stream.off("error", onError)
        const onError = (error: Error) => {
            cleanup()
            reject(error)
        }
        const onWrite = (error?: unknown) => {
            if (error !== undefined && error !== null) return
            cleanup()
            resolve()
        }

        stream.once("error", onError)
        try {
            stream.write(chunk, onWrite)
        } catch (error) {
            cleanup()
            reject(error)
        }
    })
}

async function writeFileChunk(handle: FileHandle, chunk: Uint8Array): Promise<void> {
    let offset = 0
    while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset)
        offset += result.bytesWritten
    }
}

export function isBrokenPipe(error: unknown): boolean {
    return isNodeError(error, "EPIPE")
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code
}
