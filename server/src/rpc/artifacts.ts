import type { Loopy } from "@loopy/core/loopy"
import { toArtifact } from "../mappers"
import { notFound, required, toConnectError } from "./errors"
import type { LoopyServiceImplementation } from "./types"

type ArtifactHandlers = Pick<LoopyServiceImplementation, "getArtifact" | "readArtifact">

export function artifactHandlers(loopy: Loopy): ArtifactHandlers {
    return {
        async getArtifact(request) {
            required(request.artifactId, "artifact_id")
            try {
                return { artifact: toArtifact(await loopy.artifacts.get(request.artifactId)) }
            } catch (error) {
                throw toConnectError(error, {
                    artifact_not_found: () => notFound("Artifact", request.artifactId)
                })
            }
        },
        async *readArtifact(request, context) {
            required(request.artifactId, "artifact_id")
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
            try {
                const content = await loopy.artifacts.read(request.artifactId)
                reader = content.stream.getReader()
                while (!context.signal.aborted) {
                    const item = await reader.read()
                    if (item.done) return
                    yield { chunk: item.value }
                }
            } catch (error) {
                throw toConnectError(error, {
                    artifact_not_found: () => notFound("Artifact", request.artifactId)
                })
            } finally {
                if (reader !== undefined) {
                    await reader.cancel().catch(() => {})
                    reader.releaseLock()
                }
            }
        }
    }
}
