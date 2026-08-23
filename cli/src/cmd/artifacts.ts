import * as path from "node:path"
import {
    ArtifactKind,
    GetArtifactResponseSchema,
    ReadArtifactResponseSchema,
    type Artifact,
    type GetArtifactResponse
} from "@clankhouse/server/proto"
import type { Command } from "commander"
import { copyWithoutClobber, writeBytes } from "../io"
import { indent } from "../output"
import type { Runtime } from "../runtime"

export function registerArtifacts(program: Command, runtime: Runtime): void {
    const artifacts = program.command("artifacts").description("Inspect workflow artifacts")
    artifacts
        .command("get")
        .description("Get artifact metadata")
        .argument("<artifact-id>")
        .action(async (artifactId: string, _options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.getArtifact({ artifactId }, { signal: runtime.signal })
            await runtime.emit(command, GetArtifactResponseSchema, response, () => formatArtifact(response))
        })
    artifacts
        .command("read")
        .description("Read artifact content")
        .argument("<artifact-id>")
        .action(async (artifactId: string, _options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const output = runtime.output(command)
            for await (const response of client.readArtifact({ artifactId }, { signal: runtime.signal })) {
                if (output.json) await output.proto(ReadArtifactResponseSchema, response)
                else await writeBytes(runtime.stdout, response.chunk)
            }
        })
    artifacts
        .command("copy")
        .description("Copy artifact content to a file")
        .argument("<artifact-id>")
        .argument("<out-file>")
        .action(async (artifactId: string, outFile: string, _options: unknown, command: Command) => {
            const destination = path.resolve(runtime.cwd, outFile)
            const client = await runtime.client(command)
            const metadata = await client.getArtifact({ artifactId }, { signal: runtime.signal })
            await copyWithoutClobber(destination, async function* () {
                for await (const response of client.readArtifact({ artifactId }, { signal: runtime.signal })) {
                    yield response.chunk
                }
            })
            await runtime.emit(
                command,
                GetArtifactResponseSchema,
                metadata,
                () => `Copied ${artifactId} to ${destination}\n`
            )
        })
}

function formatArtifact(response: GetArtifactResponse): string {
    const artifact = response.artifact
    if (artifact === undefined) return "Artifact response is empty.\n"
    return (
        [
            `Artifact ${artifact.id}`,
            indent(`${artifact.name} · ${artifactKind(artifact.kind)} · ${artifact.mimeType ?? "-"}`),
            indent(`Run ${artifact.runId}`),
            indent(`File ${artifact.file}`)
        ].join("\n") + "\n"
    )
}

export function formatArtifactValue(artifact: Artifact): string {
    const mime = artifact.mimeType === undefined ? "" : `, ${artifact.mimeType}`
    return `${artifact.id}: ${artifact.name} (${artifactKind(artifact.kind)}${mime})`
}

function artifactKind(value: ArtifactKind): string {
    switch (value) {
        case ArtifactKind.TEXT:
            return "text"
        case ArtifactKind.BINARY:
            return "binary"
        default:
            return "unspecified"
    }
}
