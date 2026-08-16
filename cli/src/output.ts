import { toJsonString, type DescMessage, type MessageShape } from "@bufbuild/protobuf"
import { timestampDate } from "@bufbuild/protobuf/wkt"
import { ExecutionStatus } from "@loopy/server/proto"
import { writeText } from "./io"

export type ErrorOutput = {
    code: string
    message: string
}

export type ErrorOutputOptions = {
    prefix?: string
    details?: Record<string, string>
}

export class Output {
    constructor(
        private readonly stdout: NodeJS.WritableStream,
        readonly json: boolean
    ) {}

    write(text: string): Promise<void> {
        return writeText(this.stdout, text)
    }

    proto<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): Promise<void> {
        return this.write(`${toJsonString(schema, message)}\n`)
    }
}

export function writeErrorOutput(
    stream: NodeJS.WritableStream,
    error: ErrorOutput,
    json: boolean,
    options: ErrorOutputOptions = {}
): Promise<void> {
    if (json) {
        return writeText(
            stream,
            `${JSON.stringify({ type: "error", ...options.details, code: error.code, message: error.message })}\n`
        )
    }
    return writeText(stream, `loopy: ${options.prefix ?? ""}${error.message}\n`)
}

export function prettyJson(value: string): string {
    try {
        return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
        return value
    }
}

export function executionStatus(value: ExecutionStatus): string {
    switch (value) {
        case ExecutionStatus.INTERRUPTED:
            return "interrupted"
        case ExecutionStatus.RUNNING:
            return "running"
        case ExecutionStatus.SUCCEEDED:
            return "succeeded"
        case ExecutionStatus.FAILED:
            return "failed"
        default:
            return "unspecified"
    }
}

export function timestamp(value: Parameters<typeof timestampDate>[0] | undefined): string {
    return value === undefined ? "-" : timestampDate(value).toISOString()
}

export function executionTiming(
    startedAt: Parameters<typeof timestampDate>[0] | undefined,
    endedAt: Parameters<typeof timestampDate>[0] | undefined,
    now = new Date()
): string | undefined {
    if (startedAt === undefined) return undefined
    const started = timestampDate(startedAt)
    if (endedAt !== undefined) {
        const milliseconds = Math.max(0, timestampDate(endedAt).getTime() - started.getTime())
        const totalMinutes = Math.floor(milliseconds / 60_000)
        if (totalMinutes >= 60) {
            const hours = Math.floor(totalMinutes / 60)
            return `${hours}h${totalMinutes % 60}m`
        }
        if (totalMinutes >= 1) {
            const seconds = Math.floor(milliseconds / 1000) % 60
            return `${totalMinutes}m${seconds}s`
        }
        return `${Number((milliseconds / 1000).toFixed(3))}s`
    }
    const time = `${twoDigits(started.getHours())}:${twoDigits(started.getMinutes())}`
    if (sameLocalDate(started, now)) return `from ${time}`
    return `from ${started.getFullYear()}-${twoDigits(started.getMonth() + 1)}-${twoDigits(started.getDate())} ${time}`
}

function sameLocalDate(left: Date, right: Date): boolean {
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    )
}

function twoDigits(value: number): string {
    return String(value).padStart(2, "0")
}

export function indent(value: string, levels = 1): string {
    const prefix = "  ".repeat(levels)
    return value
        .split("\n")
        .map((line) => `${prefix}${line}`)
        .join("\n")
}

export function table(headers: string[], rows: string[][]): string {
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0))
    )
    const render = (row: string[]) =>
        row
            .map((value, index) => value.padEnd(widths[index]!))
            .join("  ")
            .trimEnd()
    return `${[render(headers), ...rows.map(render)].join("\n")}\n`
}
