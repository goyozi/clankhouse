import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { toArtifact } from "../mappers.js"
import { notFound, required, throwIfAborted, toConnectError } from "./errors.js"
import type { ClankHouseServiceImplementation } from "./types.js"

type ArtifactHandlers = Pick<ClankHouseServiceImplementation, "getArtifact" | "readArtifact">

export function artifactHandlers(clankhouse: ClankHouse): ArtifactHandlers {
    return {
        async getArtifact(request) {
            required(request.artifactId, "artifact_id")
            try {
                return { artifact: toArtifact(await clankhouse.artifacts.get(request.artifactId)) }
            } catch (error) {
                throw toConnectError(error, {
                    artifact_not_found: () => notFound("Artifact", request.artifactId)
                })
            }
        },
        async *readArtifact(request, context) {
            required(request.artifactId, "artifact_id")
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
            const abort = () => {
                void reader?.cancel(context.signal.reason).catch(() => {})
            }
            context.signal.addEventListener("abort", abort, { once: true })
            try {
                const content = await clankhouse.artifacts.read(request.artifactId)
                reader = content.stream.getReader()
                throwIfAborted(context.signal)
                while (true) {
                    const item = await reader.read()
                    throwIfAborted(context.signal)
                    if (item.done) return
                    yield { chunk: item.value }
                }
            } catch (error) {
                throw toConnectError(error, {
                    artifact_not_found: () => notFound("Artifact", request.artifactId)
                })
            } finally {
                context.signal.removeEventListener("abort", abort)
                if (reader !== undefined) {
                    await reader.cancel().catch(() => {})
                    reader.releaseLock()
                }
            }
        }
    }
}
