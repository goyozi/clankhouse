import * as z from "zod"
import { runContext } from "./context.js"
import * as sql from "./db.js"
import type { Db } from "./db.js"
import type { Engine } from "./engine.js"
import { ClankHouseError } from "./errors.js"
import { jsonSchema } from "./json-schema.js"
import { newId, nowIso } from "./util.js"

export type EventSourceHandle = {
    stop(): void
    check?(): Promise<void>
}

export type EventSourceListener<T> = {
    emit(event: T): void
    fail(error: unknown): void
}

export type ApiEventSource<T extends z.ZodTypeAny = z.ZodTypeAny> = {
    key: string
    schema: T
    start?: never
}

export type ActiveEventSource<T extends z.ZodTypeAny = z.ZodTypeAny> = {
    key: string
    schema: T
    start(listener: EventSourceListener<z.input<T>>): EventSourceHandle
}

export type EventSource<T extends z.ZodTypeAny = z.ZodTypeAny> = ApiEventSource<T> | ActiveEventSource<T>

export type EventSourceResult<S extends EventSource> = S extends {
    key: infer K extends string
    schema: infer T extends z.ZodTypeAny
}
    ? { key: K; event: z.output<T> }
    : never

type Waiter = {
    active: boolean
    handles: Set<EventSourceHandle>
    keys: string[]
    stepId: string
    resolve(result: { key: string; event: unknown }): void
    reject(error: unknown): void
}

export class Events {
    private readonly db: Db
    private readonly engine: Engine
    private readonly waiters = new Map<string, Waiter>()

    constructor(db: Db, engine: Engine) {
        this.db = db
        this.engine = engine
    }

    async emit(key: string, event: unknown): Promise<void> {
        const ctx = runContext.getStore()
        if (!ctx) return this.persist(key, event)
        await this.engine.executeStep({
            kind: "event",
            name: `emit:${key}`,
            schema: z.void(),
            execute: async (handle) => {
                this.persist(key, event, `${ctx.workflowName}/${ctx.runKey}/${handle.stepKey}`)
                handle.set("event_key", key)
            }
        })
    }

    async waitFor<T extends z.ZodTypeAny>(source: EventSource<T>): Promise<z.output<T>> {
        const result = await this.waitForEventStep([source], `wait:${source.key}`)
        return result.event as z.output<T>
    }

    async waitForAny<const S extends readonly EventSource[]>(sources: S): Promise<EventSourceResult<S[number]>> {
        if (sources.length === 0) {
            throw new ClankHouseError("event_sources_empty", "waitForAny requires at least one event source")
        }
        return this.waitForEventStep(sources, `wait:${sources.map((source) => source.key).join("+")}`) as Promise<
            EventSourceResult<S[number]>
        >
    }

    close(): void {
        for (const waiter of new Set(this.waiters.values())) this.deactivate(waiter)
    }

    private waitForEventStep(
        sources: readonly EventSource[],
        stepName: string
    ): Promise<{ key: string; event: unknown }> {
        for (const source of sources) {
            jsonSchema({ schema: source.schema, io: "input", role: `Event "${source.key}" payload schema` })
        }
        const variants = sources.map((source) => z.object({ key: z.literal(source.key), event: source.schema }))
        const schema = variants.length === 1 ? variants[0] : z.union(variants)
        return this.engine.executeStep({
            kind: "event",
            name: stepName,
            schema,
            schemaIo: "input",
            schemaRole: `Event wait "${sources.map((source) => source.key).join("+")}" schema`,
            parse(value) {
                try {
                    return schema.parse(value)
                } catch (error) {
                    if (!(error instanceof z.ZodError)) throw error
                    const key = eventKey(value)
                    throw new ClankHouseError(
                        "event_schema_validation_failed",
                        `Event on "${key}" failed schema validation: ${error.message}`,
                        { cause: error }
                    )
                }
            },
            execute: async (handle) => {
                const result = await this.waitForEvent(sources, handle.stepId)
                handle.set("event_key", result.key)
                return result
            }
        })
    }

    private persist(key: string, event: unknown, origin?: string): void {
        const id = newId()
        const payload = JSON.stringify(event)
        if (payload === undefined) {
            throw new ClankHouseError("event_payload_required", `Event "${key}" requires a JSON-serializable payload`)
        }
        if (origin !== undefined) sql.deleteUnconsumedEventsByOrigin(this.db, origin)
        sql.insertEvent(this.db, {
            id,
            key,
            payload,
            origin: origin ?? null,
            emitted_at: nowIso()
        })
        const waiter = this.waiters.get(key)
        if (!waiter) return
        this.consume(id, waiter.stepId)
        this.resolve(waiter, key, JSON.parse(payload))
    }

    private waitForEvent(sources: readonly EventSource[], stepId: string): Promise<{ key: string; event: unknown }> {
        return new Promise((resolve, reject) => {
            const waiter: Waiter = {
                active: true,
                handles: new Set(),
                keys: sources.map((source) => source.key),
                stepId,
                resolve,
                reject
            }
            const stored = sql.findDeliverableEvent(this.db, waiter.keys, stepId)
            if (stored) {
                this.consume(stored.id, stepId)
                waiter.active = false
                waiter.resolve({ key: stored.key, event: JSON.parse(stored.payload) })
                return
            }
            try {
                this.register(waiter)
                this.start(waiter, sources)
            } catch (error) {
                this.reject(waiter, error)
            }
        })
    }

    private start(waiter: Waiter, sources: readonly EventSource[]): void {
        for (const source of sources) {
            if (!waiter.active) return
            if (typeof source.start !== "function") continue
            const handle = source.start({
                emit: (event) => {
                    if (!waiter.active) return
                    try {
                        this.persist(source.key, event)
                    } catch (error) {
                        this.reject(waiter, error)
                    }
                },
                fail: (error) => this.reject(waiter, error)
            })
            if (waiter.active) waiter.handles.add(handle)
            else this.stop(handle)
        }
    }

    private register(waiter: Waiter): void {
        for (const key of waiter.keys) {
            if (this.waiters.has(key)) {
                throw new ClankHouseError(
                    "event_wait_already_registered",
                    `Another wait is already registered for event key "${key}"`
                )
            }
        }
        for (const key of waiter.keys) this.waiters.set(key, waiter)
    }

    private consume(id: string, stepId: string): void {
        sql.consumeEvent(this.db, id, nowIso(), stepId)
    }

    private resolve(waiter: Waiter, key: string, event: unknown): void {
        if (!waiter.active) return
        this.deactivate(waiter)
        waiter.resolve({ key, event })
    }

    private reject(waiter: Waiter, error: unknown): void {
        if (!waiter.active) return
        this.deactivate(waiter)
        waiter.reject(error)
    }

    private deactivate(waiter: Waiter): void {
        if (!waiter.active) return
        waiter.active = false
        this.deregister(waiter)
        for (const handle of waiter.handles) this.stop(handle)
        waiter.handles.clear()
    }

    private deregister(waiter: Waiter): void {
        for (const key of waiter.keys) {
            if (this.waiters.get(key) === waiter) this.waiters.delete(key)
        }
    }

    private stop(handle: EventSourceHandle): void {
        try {
            handle.stop()
        } catch {}
    }
}

function eventKey(value: unknown): string {
    if (typeof value === "object" && value !== null && "key" in value && typeof value.key === "string") {
        return value.key
    }
    return "unknown"
}
