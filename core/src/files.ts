import { statSync, watch, type FSWatcher } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import * as path from "node:path"
import * as z from "zod"
import type { ActiveEventSource, EventSourceHandle, EventSourceListener } from "./events.js"
import { isNodeError } from "./util.js"

const fileCreatedEvent = z.object({ path: z.string(), filename: z.string() })
type InitialFileEvents = "all" | "first" | "none"

/**
 * Event source for observing a specific file being created.
 *
 * Detection is based on periodic directory snapshots assisted by filesystem notifications. Changes between
 * snapshots may be coalesced, so deleting and re-creating the file may not emit another event if its absence
 * was not observed.
 */
export function fileCreated(
    target: string,
    options: { initial?: InitialFileEvents } = {}
): ActiveEventSource<typeof fileCreatedEvent> {
    const absolutePath = path.resolve(target)
    const directory = path.dirname(absolutePath)
    const filename = path.basename(absolutePath)
    const initial = options.initial ?? "all"
    return {
        key: sourceKey("created", [absolutePath, initial]),
        schema: fileCreatedEvent,
        start: (listener) =>
            watchDirectory(directory, initial, listener, async () => {
                const stats = await optionalStat(absolutePath)
                return stats?.isFile() ? [{ path: absolutePath, filename }] : []
            })
    }
}

/**
 * Event source for observing matching files being created in a given directory.
 *
 * Detection is based on periodic directory snapshots assisted by filesystem notifications. Changes between
 * snapshots may be coalesced, so deleting and re-creating a path may not emit another event if its absence
 * was not observed.
 */
export function fileCreatedIn(
    directory: string,
    options: { matching?: string; initial?: InitialFileEvents } = {}
): ActiveEventSource<typeof fileCreatedEvent> {
    const absoluteDirectory = path.resolve(directory)
    const matching = options.matching
    const initial = options.initial ?? "all"
    return {
        key: sourceKey("created-in", [absoluteDirectory, matching ?? null, initial]),
        schema: fileCreatedEvent,
        start: (listener) =>
            watchDirectory(absoluteDirectory, initial, listener, async () => {
                const entries = await readdir(absoluteDirectory, { withFileTypes: true })
                entries.sort((left, right) => compareNames(left.name, right.name))
                const events: Array<{ path: string; filename: string }> = []
                for (const entry of entries) {
                    if (!entry.isFile() && !entry.isSymbolicLink()) continue
                    if (matching !== undefined && !path.matchesGlob(entry.name, matching)) continue
                    const absolutePath = path.join(absoluteDirectory, entry.name)
                    const stats = await optionalStat(absolutePath)
                    if (stats?.isFile()) events.push({ path: absolutePath, filename: entry.name })
                }
                return events
            })
    }
}

function watchDirectory(
    directory: string,
    initial: InitialFileEvents,
    listener: EventSourceListener<{ path: string; filename: string }>,
    find: () => Promise<Array<{ path: string; filename: string }>>
): EventSourceHandle {
    requireDirectory(directory)
    let observed = new Set<string>()
    let initialized = false
    let active = true
    let scanning = false
    let pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let watcher: FSWatcher | undefined

    const stop = () => {
        if (!active) return
        active = false
        clearInterval(interval)
        watcher?.removeListener("error", watchFailed)
        watcher?.close()
        for (const request of pending) request.resolve()
        pending = []
    }
    const fail = (error: unknown) => {
        if (!active) return
        try {
            listener.fail(error)
        } catch {}
    }
    const watchFailed = () => {
        if (!active) return
        watcher?.removeListener("error", watchFailed)
        watcher?.close()
        watcher = undefined
        scheduleScan()
    }
    const check = (): Promise<void> => {
        if (!active) return Promise.resolve()
        const promise = new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
        startScanning()
        return promise
    }
    const scheduleScan = () => {
        void check().catch(() => {})
    }
    const startScanning = () => {
        if (!active || scanning) return
        scanning = true
        void (async () => {
            while (active && pending.length > 0) {
                const requests = pending
                pending = []
                try {
                    const events = await find()
                    const present = new Set(events.map((event) => event.path))
                    const emitted = initialized
                        ? events.filter((event) => !observed.has(event.path))
                        : initial === "all"
                          ? events
                          : initial === "first"
                            ? events.slice(0, 1)
                            : []
                    observed = present
                    for (const event of emitted) observed.delete(event.path)
                    initialized = true
                    for (const event of emitted) {
                        if (!active) break
                        listener.emit(event)
                        observed.add(event.path)
                    }
                    for (const request of requests) request.resolve()
                } catch (error) {
                    for (const request of requests) request.reject(error)
                    fail(error)
                }
            }
        })().finally(() => {
            scanning = false
            if (active && pending.length > 0) startScanning()
        })
    }

    try {
        watcher = watch(directory, scheduleScan)
        watcher.on("error", watchFailed)
    } catch {}
    const interval = setInterval(scheduleScan, 1_000)
    scheduleScan()
    return { stop, check }
}

function requireDirectory(directory: string): void {
    const stats = statSync(directory)
    if (!stats.isDirectory()) throw new Error(`File event source requires a directory: ${directory}`)
}

async function optionalStat(target: string) {
    try {
        return await stat(target)
    } catch (error) {
        if (isNodeError(error, "ENOENT")) return undefined
        throw error
    }
}

function sourceKey(kind: string, parts: unknown[]): string {
    return `file:${kind}:${JSON.stringify(parts)}`
}

function compareNames(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}
