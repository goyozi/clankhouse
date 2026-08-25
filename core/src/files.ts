import { statSync, watch, type FSWatcher } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import * as path from "node:path"
import * as z from "zod"
import type { EventSource, EventSourceHandle, EventSourceListener } from "./events.js"
import { isNodeError } from "./util.js"

const fileCreatedEvent = z.object({ path: z.string(), filename: z.string() })

/**
 * Event source for observing a specific file being created.
 *
 * Fires immediately if file exists upon event source creation.
 *
 * Detection is based on periodic directory snapshots assisted by filesystem notifications. Changes between
 * snapshots may be coalesced, so deleting and re-creating the file may not emit another event if its absence
 * was not observed.
 */
export function fileCreated(target: string): EventSource<typeof fileCreatedEvent> {
    const absolutePath = path.resolve(target)
    const directory = path.dirname(absolutePath)
    const filename = path.basename(absolutePath)
    return {
        key: sourceKey("created", [absolutePath]),
        schema: fileCreatedEvent,
        start: (listener) =>
            watchDirectory(directory, listener, async () => {
                const stats = await optionalStat(absolutePath)
                return stats?.isFile() ? [{ path: absolutePath, filename }] : []
            })
    }
}

/**
 * Event source for observing matching files being created in a given directory.
 *
 * Fires immediately if matching files exist upon event source creation.
 *
 * Detection is based on periodic directory snapshots assisted by filesystem notifications. Changes between
 * snapshots may be coalesced, so deleting and re-creating a path may not emit another event if its absence
 * was not observed.
 */
export function fileCreatedIn(
    directory: string,
    options: { matching?: string } = {}
): EventSource<typeof fileCreatedEvent> {
    const absoluteDirectory = path.resolve(directory)
    const matching = options.matching
    return {
        key: sourceKey("created-in", [absoluteDirectory, matching ?? null]),
        schema: fileCreatedEvent,
        start: (listener) =>
            watchDirectory(absoluteDirectory, listener, async () => {
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
    listener: EventSourceListener<{ path: string; filename: string }>,
    find: () => Promise<Array<{ path: string; filename: string }>>
): EventSourceHandle {
    requireDirectory(directory)
    let observed = new Set<string>()
    let active = true
    let scanning = false
    let pending = false
    let watcher: FSWatcher | undefined

    const stop = () => {
        if (!active) return
        active = false
        clearInterval(interval)
        watcher?.removeListener("error", watchFailed)
        watcher?.close()
    }
    const fail = (error: unknown) => {
        if (active) listener.fail(error)
    }
    const watchFailed = () => {
        if (!active) return
        watcher?.removeListener("error", watchFailed)
        watcher?.close()
        watcher = undefined
        scan()
    }
    const scan = () => {
        if (!active) return
        if (scanning) {
            pending = true
            return
        }
        scanning = true
        void (async () => {
            while (active) {
                pending = false
                const events = await find()
                const present = new Set(events.map((event) => event.path))
                for (const event of events) {
                    if (!active) return
                    if (observed.has(event.path)) continue
                    listener.emit(event)
                }
                observed = present
                if (!pending) return
            }
        })()
            .catch(fail)
            .finally(() => {
                scanning = false
                if (active && pending) scan()
            })
    }

    try {
        watcher = watch(directory, scan)
        watcher.on("error", watchFailed)
    } catch {}
    const interval = setInterval(scan, 1_000)
    scan()
    return { stop }
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
