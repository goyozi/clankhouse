import * as fs from "node:fs"
import * as path from "node:path"
import { expect, test } from "vitest"
import type { Artifact } from "@loopy/core/artifacts"
import { Loopy } from "@loopy/core/loopy"
import { gate, tempLoopy, testRun } from "@loopy/test-utils"

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
    }
    return Buffer.concat(chunks)
}

test("writeText creates a durable artifact step", async () => {
    // given a fresh loopy instance
    const { loopy } = tempLoopy()
    let artifact!: Artifact

    // when writing a text artifact inside a durable step
    await testRun(loopy, async () => {
        artifact = await loopy.artifacts.writeText("report", "hello", "text/markdown")
        return null
    })

    // then the returned artifact has the expected name, kind and mime type
    expect(artifact.name).toBe("report")
    expect(artifact.kind).toBe("text")
    expect(artifact.mimeType).toBe("text/markdown")
    // and the artifact file is written to disk under the loopy dir
    expect(fs.existsSync(path.join(loopy.loopyDir, artifact.file))).toBe(true)
    // and the text content can be read back
    expect(await loopy.artifacts.readText(artifact.id)).toEqual({
        text: "hello",
        mimeType: "text/markdown"
    })
    // and the run records the artifact
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    expect(run.artifacts).toEqual([artifact])
    // and the run has an artifact step keyed by the artifact name
    const step = run.steps[0]
    expect(step.kind).toBe("artifact")
    expect(step.key).toBe("artifact:report")
    if (step.kind === "artifact") {
        expect(step.artifactId).toBe(artifact.id)
        expect(step.output).toEqual(artifact)
    }
})

test("writeBinary pumps the stream into an artifact file", async () => {
    // given a fresh loopy instance and some binary data
    const { loopy } = tempLoopy()
    const data = new Uint8Array([1, 2, 3, 250])
    let artifact!: Artifact

    // when writing a binary artifact from a readable stream
    await testRun(loopy, async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(data)
                controller.close()
            }
        })
        artifact = await loopy.artifacts.writeBinary("blob", stream, "application/octet-stream")
        return null
    })

    // then reading the artifact back yields the original mime type
    const result = await loopy.artifacts.readBinary(artifact.id)
    expect(result.mimeType).toBe("application/octet-stream")
    // and the streamed bytes match what was written
    expect(await collect(result.stream)).toEqual(Buffer.from(data))
})

test("artifact writes are replayed without duplicating rows after resume", async () => {
    // given a loopy instance that can be reopened, and a workflow body that writes one artifact then optionally blocks
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    const artifacts: Artifact[] = []
    const body = (l: Loopy, block: boolean) => async () => {
        artifacts.push(await l.artifacts.writeText("report", "hello"))
        reached.release()
        if (block) await parked.released
        return null
    }

    // when the first run writes the artifact and then blocks before completing
    testRun(loopy, body(loopy, true)).catch(() => {})
    await reached.released
    const second = reopen()

    // and when the run resumes on a reopened loopy and completes without blocking
    await testRun(second, body(second, false))

    // then the artifact write is replayed, returning the same artifact both times
    expect(artifacts).toHaveLength(2)
    expect(artifacts[1]).toEqual(artifacts[0])
    // and only a single artifact row is persisted despite the replay
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 1 })
    // and the artifact content is still readable after resume
    expect(await second.artifacts.readText(artifacts[0].id)).toEqual({ text: "hello" })
})

test("artifact names that sanitize identically do not collide", async () => {
    // given a fresh loopy instance
    const { loopy } = tempLoopy()
    const written: Artifact[] = []

    // when writing two artifacts whose names sanitize to the same string
    await testRun(loopy, async () => {
        written.push(await loopy.artifacts.writeText("a/b", "first"))
        written.push(await loopy.artifacts.writeText("a-b", "second"))
        return null
    })

    // then the stored files do not collide
    expect(written[0].file).not.toBe(written[1].file)
    // and both artifacts remain independently readable
    expect(await loopy.artifacts.readText(written[0].id)).toEqual({ text: "first" })
    expect(await loopy.artifacts.readText(written[1].id)).toEqual({ text: "second" })
})

test("reading a missing artifact throws", async () => {
    // given a fresh loopy instance with no artifacts written
    const { loopy } = tempLoopy()

    // when reading an artifact id that was never created
    // then it rejects with a not found error
    await expect(loopy.artifacts.readText("nope")).rejects.toThrow(/not found/)
})
