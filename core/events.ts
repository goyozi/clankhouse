import type { EventDefinition } from "./loopy"
import * as sql from "./db"
import type { DatabaseSync } from "node:sqlite"
import { newId, nowIso } from "./util"
import { decode, encode } from "./codec"

type Waiter = {
    keys: string[]
    stepId: string
    settle(key: string, event: unknown): void
}

export class Events {
    private readonly db: DatabaseSync
    private readonly waiters = new Map<string, Waiter>()

    constructor(db: DatabaseSync) {
        this.db = db
    }

    async emit(key: string, event: unknown, origin?: string): Promise<void> {
        const id = newId()
        const payload = encode(event === undefined ? null : event)
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
        waiter.settle(key, decode(payload))
    }

    waitForEvent(defs: EventDefinition<any>[], stepId: string): Promise<{ key: string; event: any }> {
        return new Promise((resolve, reject) => {
            const waiter: Waiter = {
                keys: defs.map((d) => d.key),
                stepId,
                settle: (key, event) => {
                    const def = defs.find((d) => d.key === key)!
                    const parsed = def.schema.safeParse(event)
                    if (parsed.success) resolve({ key, event: parsed.data })
                    else reject(new Error(`Event on "${key}" failed schema validation: ${parsed.error.message}`))
                }
            }
            const stored = sql.findDeliverableEvent(this.db, waiter.keys, stepId)
            if (stored) {
                this.consume(stored.id, stepId)
                waiter.settle(stored.key, decode(stored.payload))
                return
            }
            this.register(waiter)
        })
    }

    private register(waiter: Waiter): void {
        for (const key of waiter.keys) {
            if (this.waiters.has(key)) throw new Error(`Another wait is already registered for event key "${key}"`)
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
