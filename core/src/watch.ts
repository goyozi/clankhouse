export class Notifier {
    private readonly listeners = new Map<string, Set<() => void>>()

    register(key: string, listener: () => void): void {
        let set = this.listeners.get(key)
        if (!set) {
            set = new Set()
            this.listeners.set(key, set)
        }
        set.add(listener)
    }

    deregister(key: string, listener: () => void): void {
        const set = this.listeners.get(key)
        if (!set) return
        set.delete(listener)
        if (set.size === 0) this.listeners.delete(key)
    }

    notify(key: string): void {
        const set = this.listeners.get(key)
        if (!set) return
        for (const listener of [...set]) listener()
    }

    listenerCount(key: string): number {
        return this.listeners.get(key)?.size ?? 0
    }
}

export async function* watch<T>(
    notifier: Notifier,
    key: string,
    drain: () => T[],
    isActive: () => boolean,
    signal?: AbortSignal
): AsyncGenerator<T, void, void> {
    let notified: boolean
    let wake = deferred()
    const listener = () => {
        notified = true
        wake.release()
    }
    notifier.register(key, listener)
    const onAbort = () => {
        notifier.deregister(key, listener)
        wake.release()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
        while (true) {
            if (signal?.aborted) return
            notified = false
            for (const item of drain()) {
                yield item
                if (signal?.aborted) return
            }
            if (notified) continue
            if (!isActive()) return
            wake = deferred()
            await wake.released
        }
    } finally {
        notifier.deregister(key, listener)
        signal?.removeEventListener("abort", onAbort)
    }
}

function deferred(): { released: Promise<void>; release: () => void } {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
        release = resolve
    })
    return { released, release }
}
