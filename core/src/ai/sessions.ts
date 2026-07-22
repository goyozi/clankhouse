import * as sql from "../db"
import type { Db, SessionMessageRow } from "../db"
import { observableStatus, type ActiveSets } from "../runtime"
import { LoopyError } from "../errors"
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
        if (!row) throw new LoopyError("ai_session_not_found", `AI session not found: ${id}`)
        return {
            id: row.id,
            kind: row.kind,
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
            throw new LoopyError("ai_session_not_found", `AI session not found: ${id}`)
        }
        let lastSeq = -1
        if (options?.afterMessageId !== undefined) {
            const row = sql.findSessionMessageById(this.db, options.afterMessageId)
            if (!row || row.session_id !== id)
                throw new LoopyError(
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

    create(options: { kind: "llm" | "coding-agent"; provider: string; model: string }): SessionRecorder {
        const id = newId()
        const db = this.db
        const active = this.active.sessions
        const notify = () => this.notifier.notify(id)
        sql.insertSession(db, {
            id,
            kind: options.kind,
            provider: options.provider,
            model: options.model,
            started_at: nowIso()
        })
        active.add(id)
        let seq = 0
        return {
            id,
            addMessage(role, content) {
                sql.insertSessionMessage(db, {
                    id: newId(),
                    session_id: id,
                    seq: seq++,
                    role,
                    content,
                    created_at: nowIso()
                })
                notify()
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
    return {
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        createdAt: new Date(row.created_at)
    }
}

export type SessionRecorder = {
    id: string
    addMessage(role: AISessionMessage["role"], content: string): void
    succeed(): void
    fail(): void
}

export type AISession = {
    id: string
    kind: "llm" | "coding-agent"
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

export type AISessionMessage = {
    id: string
    sessionId: string
    role: "system" | "user" | "assistant" | "tool" | "tool_result"
    content: string
    createdAt: Date
}
