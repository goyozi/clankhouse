import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test, vi } from "vitest"
import { gate, runOutput, tempDir } from "@loopy/test-utils"

function withLoopyDir<T>(prefix: string, body: (dir: string) => Promise<T>): Promise<T> {
    const dir = path.join(tempDir(prefix), "loopy")
    const previous = process.env.LOOPY_DIR
    process.env.LOOPY_DIR = dir
    vi.resetModules()
    return body(dir).finally(() => {
        if (previous === undefined) delete process.env.LOOPY_DIR
        else process.env.LOOPY_DIR = previous
    })
}

test("importing the package does not create the loopy dir until first use", async () => {
    await withLoopyDir("loopy-lazy-", async (dir) => {
        // given the package freshly imported under a LOOPY_DIR that does not yet exist
        const mod = await import("@loopy/core")
        // then the loopy dir is not created just from importing
        expect(fs.existsSync(dir)).toBe(false)

        // when getting the loopy instance for the first time
        const instance = mod.loopy()
        // then the loopy db file is created
        expect(fs.existsSync(path.join(dir, "loopy.db"))).toBe(true)
        // and calling loopy() again returns the same cached instance
        expect(mod.loopy()).toBe(instance)
        instance.close()
    })
})

test("a closed singleton is replaced instead of handed out again", async () => {
    await withLoopyDir("loopy-reopen-", async () => {
        // given the cached singleton instance
        const mod = await import("@loopy/core")
        const first = mod.loopy()

        // when it is closed and the singleton is requested again
        first.close()
        const second = mod.loopy()

        // then a usable instance replaces the closed one
        expect(second).not.toBe(first)
        expect(second.closed).toBe(false)
        expect(await second.runs.list()).toEqual([])
        second.close()
    })
})

test("top-level workflow functions delegate to the singleton loopy instance", async () => {
    await withLoopyDir("loopy-index-", async () => {
        // given the lazily-created singleton instance
        const mod = await import("@loopy/core")
        const instance = mod.loopy()

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
        instance.close()
    })
})
