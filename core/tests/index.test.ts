import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test, vi } from "vitest"
import type { EventSourceListener } from "@clankhouse/core/events"
import { gate, runOutput, tempDir } from "@clankhouse/test-utils"

function withClankHouseDir<T>(prefix: string, body: (dir: string) => Promise<T>): Promise<T> {
    const dir = path.join(tempDir(prefix), "clankhouse")
    const previous = process.env.CLANKHOUSE_DIR
    process.env.CLANKHOUSE_DIR = dir
    vi.resetModules()
    return body(dir).finally(() => {
        if (previous === undefined) delete process.env.CLANKHOUSE_DIR
        else process.env.CLANKHOUSE_DIR = previous
    })
}

test("importing the package does not create the clankhouse dir until first use", async () => {
    await withClankHouseDir("clankhouse-lazy-", async (dir) => {
        // given the package freshly imported under a CLANKHOUSE_DIR that does not yet exist
        const mod = await import("@clankhouse/core")
        // then the clankhouse dir is not created just from importing
        expect(fs.existsSync(dir)).toBe(false)

        // when getting the clankhouse instance for the first time
        const instance = mod.clankhouse()
        // then the clankhouse db file is created
        expect(fs.existsSync(path.join(dir, "clankhouse.db"))).toBe(true)
        // and calling clankhouse() again returns the same cached instance
        expect(mod.clankhouse()).toBe(instance)
        instance.close()
    })
})

test("a closed singleton is replaced instead of handed out again", async () => {
    await withClankHouseDir("clankhouse-reopen-", async () => {
        // given the cached singleton instance
        const mod = await import("@clankhouse/core")
        const first = mod.clankhouse()

        // when it is closed and the singleton is requested again
        first.close()
        const second = mod.clankhouse()

        // then a usable instance replaces the closed one
        expect(second).not.toBe(first)
        expect(second.closed).toBe(false)
        expect(await second.runs.list()).toEqual([])
        second.close()
    })
})

test("top-level workflow functions delegate to the singleton clankhouse instance", async () => {
    await withClankHouseDir("clankhouse-index-", async () => {
        // given the lazily-created singleton instance
        const mod = await import("@clankhouse/core")
        const instance = mod.clankhouse()

        // then the top-level workflows accessor exposes the singleton's public service
        expect(mod.workflows()).toBe(instance.workflows)

        // given a registered workflow parked after entering a durable step
        const parked = gate()
        mod.registerWorkflow(
            "index-workflow",
            {
                input: z.object({ id: z.string(), value: z.number() }),
                output: z.number(),
                key: (input) => input.id
            },
            async (input) => {
                const value = await instance.step("compute", z.number(), async () => input.value * 2)
                await parked.released
                return value
            }
        )
        const runId = mod.start("index-workflow", { id: "x", value: 2 })

        // when the top-level resume targets the still-active run
        // then it returns the same run ID rather than a new attempt
        expect(mod.resume(runId)).toBe(runId)
        parked.release()
        expect(await runOutput(instance, runId)).toBe(4)

        // when the top-level rerun restarts the completed run from its step
        const rerunId = mod.rerun(runId, { from: "compute" })
        // then it returns a new run ID whose attempt succeeds
        expect(rerunId).not.toBe(runId)
        expect(await runOutput(instance, rerunId)).toBe(4)

        // given a second workflow registered through the top-level API and an active source
        const triggerRef = mod.registerWorkflow(
            "index-trigger",
            { input: z.string(), output: z.string(), key: (input) => input },
            async (input) => input.toUpperCase()
        )
        let listener: EventSourceListener<string> | undefined
        let stops = 0

        // when a trigger is added and its source emits
        const trigger = mod.addTrigger(
            {
                key: "index-trigger",
                schema: z.string(),
                start(value) {
                    listener = value
                    return { stop: () => stops++ }
                }
            },
            triggerRef
        )
        listener?.emit("triggered")

        // then the top-level functions use the singleton instance and return a stoppable handle
        const triggeredRun = (await instance.runs.list({ workflowName: "index-trigger", key: "triggered" }))[0]
        expect(await runOutput(instance, triggeredRun.id)).toBe("TRIGGERED")
        trigger.stop()
        expect(stops).toBe(1)
        instance.close()
    })
})
