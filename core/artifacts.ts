import * as z from "zod";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { requireContext } from "./context";
import * as sql from "./db";
import type { ArtifactRow } from "./db";
import type { DatabaseSync } from "node:sqlite";
import type { Engine } from "./engine";
import { newId, nowIso, uniqueName } from "./util";

export const ArtifactSchema = z.object({
    id: z.string(),
    runId: z.string(),
    name: z.string(),
    file: z.string(),
    kind: z.enum(["text", "binary"]),
    mimeType: z.string().optional()
});

export class Artifacts {
    private readonly loopyDir: string
    private readonly db: DatabaseSync
    private readonly engine: Engine

    constructor(loopyDir: string, db: DatabaseSync, engine: Engine) {
        this.loopyDir = loopyDir
        this.db = db
        this.engine = engine
    }

    /**
     * Durable step creating a text-based artifact.
     */
    async writeText(name: string, text: string, mimeType?: string): Promise<Artifact> {
        return this.write(name, "text", mimeType, file => writeFile(file, text));
    }

    async readText(id: string): Promise<TextArtifact> {
        const row = this.rowById(id);
        const text = await readFile(path.join(this.loopyDir, row.file), "utf8");
        return { text, ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}) };
    }

    /**
     * Durable step creating a binary artifact.
     * On replay the provided stream is not consumed.
     */
    async writeBinary(name: string, stream: ReadableStream<Uint8Array>, mimeType?: string): Promise<Artifact> {
        return this.write(name, "binary", mimeType, file => pipeline(Readable.fromWeb(stream), createWriteStream(file)));
    }

    async readBinary(id: string): Promise<BinaryArtifact> {
        const row = this.rowById(id);
        const stream = Readable.toWeb(createReadStream(path.join(this.loopyDir, row.file))) as ReadableStream<Uint8Array>;
        return { stream, ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}) };
    }

    private write(name: string, kind: "text" | "binary", mimeType: string | undefined, writeFile: (file: string) => Promise<void>): Promise<Artifact> {
        return this.engine.executeStep({
            kind: "artifact",
            name: `artifact:${name}`,
            schema: ArtifactSchema,
            execute: async (handle) => {
                const ctx = requireContext();
                const relative = artifactFile(ctx.runId, handle.stepKey);
                const absolute = path.join(this.loopyDir, relative);
                await mkdir(path.dirname(absolute), { recursive: true });
                await writeFile(absolute);
                const id = newId();
                sql.insertArtifact(this.db, { id, run_id: ctx.runId, name, file: relative, kind, mime_type: mimeType ?? null, created_at: nowIso() });
                handle.set("artifact_id", id);
                sql.deleteDuplicateArtifacts(this.db, ctx.runId, relative, id);
                return { id, runId: ctx.runId, name, file: relative, kind, ...(mimeType !== undefined ? { mimeType } : {}) };
            }
        });
    }

    private rowById(id: string): ArtifactRow {
        const row = sql.findArtifactById(this.db, id);
        if (!row) throw new Error(`Artifact not found: ${id}`);
        return row;
    }
}

export function artifactFile(runId: string, stepKey: string): string {
    return path.join("artifacts", runId, uniqueName(stepKey));
}

export type Artifact = {
    id: string,
    runId: string,
    name: string,
    file: string,
    kind: "text" | "binary",
    mimeType?: string
}

export type TextArtifact = {
    text: string,
    mimeType?: string
}

export type BinaryArtifact = {
    stream: ReadableStream<Uint8Array>,
    mimeType?: string
}
