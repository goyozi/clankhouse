import { expect, test } from "vitest"
import { Notifier, watch } from "@clankhouse/core/watch"

test("watch re-drains changes that land before the source goes inactive during a pending yield", async () => {
    // given a watch over a drain that emits queued batches and a controllable activity flag
    const notifier = new Notifier()
    let active = true
    const batches: number[][] = [[1], [2]]
    const it = watch(
        notifier,
        "k",
        () => batches.shift() ?? [],
        () => active
    )

    // when the first batch is pulled
    expect((await it.next()).value).toBe(1)

    // and a change is notified as the source goes inactive, before the next pull
    active = false
    notifier.notify("k")

    // then the queued change is still delivered rather than the stream ending early
    expect((await it.next()).value).toBe(2)
    // and the stream ends on the following pull
    expect((await it.next()).done).toBe(true)
})

test("watch deregisters its listener when the signal aborts, even if the generator is abandoned", async () => {
    // given a watch iterator pulled once so it parks on a live source, then abandoned
    const notifier = new Notifier()
    const controller = new AbortController()
    const it = watch(
        notifier,
        "k",
        () => [],
        () => true,
        controller.signal
    )
    const pull = it.next()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // then it has registered a listener on the shared notifier
    expect(notifier.listenerCount("k")).toBe(1)

    // when the signal aborts and the consumer never resumes the iterator itself
    controller.abort()

    // then the listener is removed immediately, leaking nothing on the notifier
    expect(notifier.listenerCount("k")).toBe(0)
    // and the abandoned pull settles as done rather than hanging
    expect((await pull).done).toBe(true)
})
