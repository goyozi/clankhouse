import * as z from "zod"
import { copyFileSync, createWriteStream, mkdirSync } from "node:fs"
import { mkdir, open, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { requireContext } from "./context"
import * as sql from "./db"
import type { ArtifactRow, Db, StepRow } from "./db"
import type { Engine } from "./engine"
import { ClankHouseError } from "./errors"
import { isNodeError, newId, nowIso, uniqueName } from "./util"

export const ArtifactSchema = z.object({
    id: z.string(),
    runId: z.string(),
    name: z.string(),
    file: z.string(),
    kind: z.enum(["text", "binary"]),
    mimeType: z.string().optional()
})

export class Artifacts {
    private readonly clankhouseDir: string
    private readonly db: Db
    private readonly engine: Engine

    constructor(clankhouseDir: string, db: Db, engine: Engine) {
        this.clankhouseDir = clankhouseDir
        this.db = db
        this.engine = engine
    }

    /**
     * Durable step creating a text-based artifact.
     */
    async writeText(name: string, text: string, mimeType?: string): Promise<Artifact> {
        return this.write(name, "text", mimeType, (file) => writeFile(file, text))
    }

    async readText(id: string): Promise<TextArtifact> {
        const row = this.rowById(id)
        const text = await this.readBacking(id, () => readFile(path.join(this.clankhouseDir, row.file), "utf8"))
        return { text, ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}) }
    }

    async get(id: string): Promise<Artifact> {
        return toArtifact(this.rowById(id))
    }

    async read(id: string): Promise<ArtifactContent> {
        const row = this.rowById(id)
        const file = await this.readBacking(id, () => open(path.join(this.clankhouseDir, row.file), "r"))
        const stream = Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>
        return { stream, ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}) }
    }

    private async readBacking<T>(id: string, read: () => Promise<T>): Promise<T> {
        try {
            return await read()
        } catch (error) {
            if (isNodeError(error, "ENOENT")) {
                throw new ClankHouseError("artifact_not_found", `Artifact not found: ${id}`, { cause: error })
            }
            throw error
        }
    }

    /**
     * Durable step creating a binary artifact.
     * On replay the provided stream is not consumed.
     */
    async writeBinary(name: string, stream: ReadableStream<Uint8Array>, mimeType?: string): Promise<Artifact> {
        return this.write(name, "binary", mimeType, (file) =>
            pipeline(Readable.fromWeb(stream), createWriteStream(file))
        )
    }

    private write(
        name: string,
        kind: "text" | "binary",
        mimeType: string | undefined,
        writeFile: (file: string) => Promise<void>
    ): Promise<Artifact> {
        return this.engine.executeStep({
            kind: "artifact",
            name: `artifact:${name}`,
            schema: ArtifactSchema,
            execute: async (handle) => {
                const ctx = requireContext()
                const relative = artifactFile(ctx.runId, handle.stepKey)
                const absolute = path.join(this.clankhouseDir, relative)
                await mkdir(path.dirname(absolute), { recursive: true })
                await writeFile(absolute)
                const id = newId()
                sql.insertArtifact(this.db, {
                    id,
                    run_id: ctx.runId,
                    name,
                    file: relative,
                    kind,
                    mime_type: mimeType ?? null,
                    created_at: nowIso()
                })
                handle.set("artifact_id", id)
                sql.deleteDuplicateArtifacts(this.db, ctx.runId, relative, id)
                return {
                    id,
                    runId: ctx.runId,
                    name,
                    file: relative,
                    kind,
                    ...(mimeType !== undefined ? { mimeType } : {})
                }
            }
        })
    }

    private rowById(id: string): ArtifactRow {
        const row = sql.findArtifactById(this.db, id)
        if (!row) throw new ClankHouseError("artifact_not_found", `Artifact not found: ${id}`)
        return row
    }

    cloneStepArtifact(step: StepRow, runId: string): { artifactId: string | null; output: string | null } {
        if (step.artifact_id === null) return { artifactId: null, output: step.output }
        const source = sql.findArtifactById(this.db, step.artifact_id)!
        const artifactId = newId()
        const file = artifactFile(runId, step.key)
        const destination = path.join(this.clankhouseDir, file)
        mkdirSync(path.dirname(destination), { recursive: true })
        copyFileSync(path.join(this.clankhouseDir, source.file), destination)
        const artifact = { ...source, id: artifactId, run_id: runId, file }
        sql.insertArtifact(this.db, artifact)
        const output =
            step.output === null ? null : JSON.stringify({ ...JSON.parse(step.output), ...toArtifact(artifact) })
        return { artifactId, output }
    }
}

export function toArtifact(row: ArtifactRow): Artifact {
    return {
        id: row.id,
        runId: row.run_id,
        name: row.name,
        file: row.file,
        kind: row.kind,
        ...(row.mime_type !== null ? { mimeType: row.mime_type } : {})
    }
}

export function artifactFile(runId: string, stepKey: string): string {
    return path.join("artifacts", runId, uniqueName(stepKey))
}

export type Artifact = {
    id: string
    runId: string
    name: string
    file: string
    kind: "text" | "binary"
    mimeType?: string
}

export type TextArtifact = {
    text: string
    mimeType?: string
}

export type ArtifactContent = {
    stream: ReadableStream<Uint8Array>
    mimeType?: string
}
