export type SessionMode = "interactive" | "redirected"
export type ResultDelivery = "instant" | "streaming"

export type TerminalLine = {
    text: string
    depth?: number
}

export type ArtifactFixture = {
    id: string
    name: string
    kind: string
    mediaType: string
}

export type Scenario = {
    id: string
    group: string
    label: string
    command: string
    summary: string
    note: string
    delivery: ResultDelivery
    lines: TerminalLine[]
    startAtTop?: boolean
}

export const line = (text: string, depth = 0): TerminalLine => ({ text, depth })
export const blank = (): TerminalLine => line("")

export function outputLines(value: unknown): TerminalLine[] {
    return [blank(), line("Output:"), ...jsonLines(value, 1)]
}

export function artifactLines(artifacts: ArtifactFixture[]): TerminalLine[] {
    if (artifacts.length === 0) return []
    return [
        blank(),
        line("Artifacts:"),
        ...artifacts.map((artifact) =>
            line(`${artifact.id}: ${artifact.name} (${artifact.kind}, ${artifact.mediaType})`, 1)
        )
    ]
}

export function jsonLines(value: unknown, depth = 0): TerminalLine[] {
    return JSON.stringify(value, null, 2)
        .split("\n")
        .map((text) => line(text, depth))
}

export function tableLines(headers: string[], rows: string[][]): TerminalLine[] {
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0))
    )
    const render = (row: string[]) =>
        row
            .map((value, index) => value.padEnd(widths[index]!))
            .join("  ")
            .trimEnd()
    return [headers, ...rows].map((row) => line(render(row)))
}
