import * as z from "zod"
import { runContext } from "./context"
import * as sql from "./db"
import type { Db } from "./db"
import type { Engine } from "./engine"
import { LoopyError } from "./errors"
import { jsonSchema } from "./json-schema"
import { newId, nowIso } from "./util"

type Waiter = {
    keys: string[]
    stepId: string
    settle(key: string, event: unknown): void
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
                await this.persist(key, event, `${ctx.workflowName}/${ctx.runKey}/${handle.stepKey}`)
                handle.set("event_key", key)
            }
        })
    }

    async waitFor<T extends z.ZodTypeAny>(key: string, schema: T): Promise<z.infer<T>> {
        const result = await this.waitForEventStep([{ key, schema }], `wait:${key}`)
        return result.event
    }

    async waitForAny(defs: EventDefinition<any>[]): Promise<any> {
        if (defs.length === 0) {
            throw new LoopyError("event_definitions_empty", "waitForAny requires at least one event definition")
        }
        return this.waitForEventStep(defs, `wait:${defs.map((d) => d.key).join("+")}`)
    }

    private waitForEventStep(defs: EventDefinition<any>[], stepName: string): Promise<{ key: string; event: any }> {
        for (const def of defs) {
            jsonSchema({ schema: def.schema, io: "input", role: `Event "${def.key}" payload schema` })
        }
        const variants = defs.map((d) => z.object({ key: z.literal(d.key), event: d.schema }))
        const schema = variants.length === 1 ? variants[0] : z.union(variants)
        return this.engine.executeStep({
            kind: "event",
            name: stepName,
            schema,
            schemaIo: "input",
            schemaRole: `Event wait "${defs.map((d) => d.key).join("+")}" schema`,
            parse(value) {
                try {
                    return schema.parse(value)
                } catch (error) {
                    if (!(error instanceof z.ZodError)) throw error
                    const key = eventKey(value)
                    throw new LoopyError(
                        "event_schema_validation_failed",
                        `Event on "${key}" failed schema validation: ${error.message}`,
                        { cause: error }
                    )
                }
            },
            execute: async (handle) => {
                const result = await this.waitForEvent(defs, handle.stepId)
                handle.set("event_key", result.key)
                return result
            }
        })
    }

    private async persist(key: string, event: unknown, origin?: string): Promise<void> {
        const id = newId()
        const payload = JSON.stringify(event)
        if (payload === undefined) {
            throw new LoopyError("event_payload_required", `Event "${key}" requires a JSON-serializable payload`)
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
        this.deregister(waiter)
        waiter.settle(key, JSON.parse(payload))
    }

    private waitForEvent(defs: EventDefinition<any>[], stepId: string): Promise<{ key: string; event: any }> {
        return new Promise((resolve) => {
            const waiter: Waiter = {
                keys: defs.map((d) => d.key),
                stepId,
                settle: (key, event) => resolve({ key, event })
            }
            const stored = sql.findDeliverableEvent(this.db, waiter.keys, stepId)
            if (stored) {
                this.consume(stored.id, stepId)
                waiter.settle(stored.key, JSON.parse(stored.payload))
                return
            }
            this.register(waiter)
        })
    }

    private register(waiter: Waiter): void {
        for (const key of waiter.keys) {
            if (this.waiters.has(key)) {
                throw new LoopyError(
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

    private deregister(waiter: Waiter): void {
        for (const key of waiter.keys) {
            if (this.waiters.get(key) === waiter) this.waiters.delete(key)
        }
    }
}

export type EventDefinition<T extends z.ZodTypeAny> = { key: string; schema: T }

function eventKey(value: unknown): string {
    if (typeof value === "object" && value !== null && "key" in value && typeof value.key === "string") {
        return value.key
    }
    return "unknown"
}
