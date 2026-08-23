import { realpathSync } from "node:fs"
import * as path from "node:path"
import * as sql from "../db"
import type { Db, SessionMessageRow } from "../db"
import { ClankHouseError } from "../errors"
import { observableStatus, type ActiveSets } from "../runtime"
import { newId, nowIso } from "../util"
import { Notifier, watch } from "../watch"

export class AISessions {
    private readonly db: Db
    private readonly active: ActiveSets
    private readonly notifier = new Notifier()

    constructor(db: Db, active: ActiveSets) {
        this.db = db
        this.active = active
    }

    async get(id: string): Promise<AISession> {
        const row = sql.findSessionById(this.db, id)
        if (!row) throw new ClankHouseError("ai_session_not_found", `AI session not found: ${id}`)
        return {
            id: row.id,
            kind: row.kind,
            client: row.client,
            provider: row.provider,
            model: row.model,
            status: observableStatus(row.status, this.active.sessions.has(row.id)),
            startedAt: new Date(row.started_at),
            ...(row.ended_at !== null ? { endedAt: new Date(row.ended_at) } : {}),
            messages: sql.findSessionMessages(this.db, id).map(toMessage)
        }
    }

    async *stream(
        id: string,
        options?: { afterMessageId?: string; signal?: AbortSignal }
    ): AsyncGenerator<AISessionMessage, void, void> {
        if (!sql.findSessionById(this.db, id)) {
            throw new ClankHouseError("ai_session_not_found", `AI session not found: ${id}`)
        }
        let lastSeq = -1
        if (options?.afterMessageId !== undefined) {
            const row = sql.findSessionMessageById(this.db, options.afterMessageId)
            if (!row || row.session_id !== id)
                throw new ClankHouseError(
                    "ai_session_message_not_found",
                    `Message not found in session ${id}: ${options.afterMessageId}`
                )
            lastSeq = row.seq
        }
        const drain = () => {
            const rows = sql.findSessionMessages(this.db, id, lastSeq)
            if (rows.length > 0) lastSeq = rows.at(-1)!.seq
            return rows.map(toMessage)
        }
        yield* watch(this.notifier, id, drain, () => this.active.sessions.has(id), options?.signal)
    }

    create(options: {
        kind: "llm" | "coding-agent"
        client: string
        provider: string
        model: string
        filesRoot?: string
    }): SessionRecorder {
        const id = newId()
        const db = this.db
        const active = this.active.sessions
        const notify = () => this.notifier.notify(id)
        const filesRoot = options.filesRoot === undefined ? undefined : canonicalPath(options.filesRoot)
        sql.insertSession(db, {
            id,
            kind: options.kind,
            client: options.client,
            provider: options.provider,
            model: options.model,
            started_at: nowIso()
        })
        active.add(id)
        let seq = 0
        const appendMessage = (kind: SessionMessageRow["kind"], payload: unknown) => {
            sql.insertSessionMessage(db, {
                id: newId(),
                session_id: id,
                seq: seq++,
                kind,
                payload: JSON.stringify(payload),
                created_at: nowIso()
            })
            notify()
        }
        return {
            id,
            addMessage(role, content) {
                appendMessage("message", { role, content })
            },
            addToolCall(call) {
                const common =
                    call.common === undefined || filesRoot === undefined
                        ? call.common
                        : normalizeCommonTool(filesRoot, call.common)
                appendMessage("tool_call", {
                    ...call,
                    input: jsonValue(call.input),
                    ...(common !== undefined ? { common } : {})
                })
            },
            addToolResult(result) {
                appendMessage("tool_result", {
                    toolCallId: result.toolCallId,
                    status: result.status,
                    ...(result.output !== undefined ? { output: jsonValue(result.output) } : {}),
                    ...(result.error !== undefined ? { error: result.error } : {})
                })
            },
            succeed() {
                sql.succeedSession(db, id, nowIso())
                active.delete(id)
                notify()
            },
            fail() {
                sql.failSession(db, id, nowIso())
                active.delete(id)
                notify()
            }
        }
    }
}

function toMessage(row: SessionMessageRow): AISessionMessage {
    const base = {
        id: row.id,
        sessionId: row.session_id,
        createdAt: new Date(row.created_at)
    }
    const payload = JSON.parse(row.payload) as JsonObject
    switch (row.kind) {
        case "message":
            return {
                ...base,
                type: "message",
                role: payload.role as SessionMessageRole,
                content: payload.content as string
            }
        case "tool_call":
            return { ...base, type: "tool_call", toolCall: payload as SessionToolCall }
        case "tool_result":
            return { ...base, type: "tool_result", toolResult: payload as SessionToolResult }
    }
}

function jsonValue(value: unknown): JsonValue {
    if (value === undefined) return null
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError("Tool payload is not JSON-serializable")
    return JSON.parse(encoded) as JsonValue
}

function normalizeFileTargets(filesRoot: string, targets: readonly string[]): string[] {
    const files = new Set<string>()
    for (const target of targets) {
        if (target.length === 0) continue
        files.add(normalizeFileTarget(filesRoot, target))
    }
    return [...files]
}

function normalizeCommonTool(filesRoot: string, common: CommonTool): CommonTool {
    switch (common.name) {
        case "file.read":
            return { ...common, path: normalizeFileTarget(filesRoot, common.path) }
        case "file.change":
            return { ...common, paths: normalizeFileTargets(filesRoot, common.paths) }
        case "file.search":
            return common.path === undefined ? common : { ...common, path: normalizeFileTarget(filesRoot, common.path) }
        case "shell.execute":
        case "web.search":
            return common
    }
}

function normalizeFileTarget(filesRoot: string, target: string): string {
    if (target.length === 0) return target
    const absolute = canonicalPath(path.resolve(filesRoot, target))
    const relative = path.relative(filesRoot, absolute)
    const inside = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    return (inside ? relative || "." : absolute).split(path.sep).join("/")
}

function canonicalPath(target: string): string {
    let current = path.resolve(target)
    const suffix: string[] = []
    while (true) {
        try {
            return path.join(realpathSync.native(current), ...suffix.reverse())
        } catch {
            const parent = path.dirname(current)
            if (parent === current) return path.resolve(target)
            suffix.push(path.basename(current))
            current = parent
        }
    }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export type JsonObject = { [key: string]: JsonValue }

export type CommonTool =
    | { name: "file.read"; path: string }
    | { name: "file.change"; paths: string[] }
    | { name: "shell.execute"; command: string }
    | { name: "file.search"; pattern?: string; path?: string }
    | { name: "web.search"; query: string }

export type ToolSource = { kind: "native" } | { kind: "provider" } | { kind: "mcp"; server: string }

export type SessionToolCall = {
    id: string
    name: string
    source: ToolSource
    common?: CommonTool
    input: JsonValue
}

export type SessionToolResult = {
    toolCallId: string
    status: "succeeded" | "failed"
    output?: JsonValue
    error?: string
}

type NewSessionToolCall = Omit<SessionToolCall, "input"> & { input: unknown }

type NewSessionToolResult = Omit<SessionToolResult, "output"> & { output?: unknown }

export type SessionRecorder = {
    id: string
    addMessage(role: SessionMessageRole, content: string): void
    addToolCall(call: NewSessionToolCall): void
    addToolResult(result: NewSessionToolResult): void
    succeed(): void
    fail(): void
}

export type AISession = {
    id: string
    kind: "llm" | "coding-agent"
    client: string
    provider: string
    model: string
    status: ObservableSessionStatus
    startedAt: Date
    endedAt?: Date
    messages: AISessionMessage[]
}

// persisted state is never "running" -> "running" stuff is in-memory only and "overlayed" on top of "interrupted"
export type PersistedSessionStatus = "interrupted" | "succeeded" | "failed"

export type ObservableSessionStatus = PersistedSessionStatus | "running"

type SessionMessageBase = {
    id: string
    sessionId: string
    createdAt: Date
}

export type SessionMessageRole = "system" | "user" | "assistant" | "reasoning"

export type AISessionMessage =
    | (SessionMessageBase & { type: "message"; role: SessionMessageRole; content: string })
    | (SessionMessageBase & { type: "tool_call"; toolCall: SessionToolCall })
    | (SessionMessageBase & { type: "tool_result"; toolResult: SessionToolResult })
