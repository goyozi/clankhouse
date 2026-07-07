import * as sql from "../db"
import type { SessionMessageRow } from "../db"
import { observableStatus, type ActiveSets } from "../runtime"
import type { DatabaseSync } from "node:sqlite"
import { newId, nowIso } from "../util"

export class AISessions {
    private readonly db: DatabaseSync
    private readonly active: ActiveSets
    private readonly listeners = new Map<string, Set<() => void>>()

    constructor(db: DatabaseSync, active: ActiveSets) {
        this.db = db
        this.active = active
    }

    async get(id: string): Promise<AISession> {
        const row = sql.findSessionById(this.db, id)
        if (!row) throw new Error(`AI session not found: ${id}`)
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

    async *stream(id: string, options?: { afterMessageId?: string }): AsyncGenerator<AISessionMessage, void, void> {
        if (!sql.findSessionById(this.db, id)) throw new Error(`AI session not found: ${id}`)
        let lastSeq = -1
        if (options?.afterMessageId !== undefined) {
            const row = sql.findSessionMessageById(this.db, options.afterMessageId)
            if (!row || row.session_id !== id)
                throw new Error(`Message not found in session ${id}: ${options.afterMessageId}`)
            lastSeq = row.seq
        }
        let notified: boolean
        let wake = deferred()
        const listener = () => {
            notified = true
            wake.release()
        }
        this.register(id, listener)
        try {
            while (true) {
                notified = false
                for (const row of sql.findSessionMessages(this.db, id, lastSeq)) {
                    lastSeq = row.seq
                    yield toMessage(row)
                }
                if (!this.active.sessions.has(id)) return
                if (notified) continue
                wake = deferred()
                await wake.released
            }
        } finally {
            this.deregister(id, listener)
        }
    }

    create(options: { kind: "llm" | "coding-agent"; provider: string; model: string }): SessionRecorder {
        const id = newId()
        const db = this.db
        const active = this.active.sessions
        const notify = () => this.notify(id)
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

    private register(id: string, listener: () => void): void {
        let set = this.listeners.get(id)
        if (!set) {
            set = new Set()
            this.listeners.set(id, set)
        }
        set.add(listener)
    }

    private deregister(id: string, listener: () => void): void {
        const set = this.listeners.get(id)
        if (!set) return
        set.delete(listener)
        if (set.size === 0) this.listeners.delete(id)
    }

    private notify(id: string): void {
        const set = this.listeners.get(id)
        if (!set) return
        for (const listener of [...set]) listener()
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

function deferred(): { released: Promise<void>; release: () => void } {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
        release = resolve
    })
    return { released, release }
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
    role: "system" | "user" | "assistant" | "tool"
    content: string
    createdAt: Date
}
