import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { gate, runOutput, tempLoopy, testRun } from "@loopy/test-utils"
import type { Loopy } from "@loopy/core/loopy"

const input = z.object({ id: z.string(), value: z.number() })
const options = { input, output: z.any(), key: (value: z.infer<typeof input>) => value.id }
const testInput = { id: "test-key", value: 1 }

function register(loopy: Loopy, body: (value: z.infer<typeof input>) => Promise<unknown>): void {
    loopy.registerWorkflow("test-workflow", options, body)
}

test("second run of a succeeded key is a no-op returning the stored output", async () => {
    // given a workflow body that counts calls and returns a fixed result
    const { loopy } = tempLoopy()
    let calls = 0
    const body = async () => {
        calls++
        return "result"
    }
    // when the run executes for the first time
    expect(await testRun(loopy, body)).toBe("result")
    // and when the same key is run again
    expect(await testRun(loopy, body)).toBe("result")
    // then the body only executed once
    expect(calls).toBe(1)
    // and only one run is recorded
    expect(await loopy.runs.list()).toHaveLength(1)
})

test("run of an actively running key awaits the existing run", async () => {
    // given a gated body and a first run that blocks on the gate
    const { loopy } = tempLoopy()
    const parked = gate()
    const first = testRun(loopy, async () => {
        await parked.released
        return 42
    })
    // when a second run starts for the same key while the first is still active
    const second = testRun(loopy, async () => 99)
    parked.release()
    // then the second run resolves with the first run's result
    expect(await second).toBe(42)
    // and the first run resolves with its own result
    expect(await first).toBe(42)
    // and only one run is recorded
    expect(await loopy.runs.list()).toHaveLength(1)
})

test("run of a failed key without rerun is an error", async () => {
    // given a loopy instance
    const { loopy } = tempLoopy()
    // when the run body throws
    // then the run fails with the thrown error
    await expect(
        testRun(loopy, async () => {
            throw new Error("boom")
        })
    ).rejects.toThrow("boom")
    // and when the same key is run again
    // then it is rejected because the key has already failed
    await expect(testRun(loopy, async () => "fine")).rejects.toThrow(/has failed/)
})

test("rerun from a step starts a new attempt reusing earlier steps", async () => {
    // given a registered workflow with step "a" that succeeds and step "b" that initially fails
    const { loopy } = tempLoopy()
    let aCalls = 0
    let bImpl: () => number = () => {
        throw new Error("boom")
    }
    register(loopy, async () => {
        const a = await loopy.step("a", z.number(), async () => {
            aCalls++
            return 1
        })
        const b = await loopy.step("b", z.number(), async () => bImpl())
        return a + b
    })
    // when the first attempt fails at step "b"
    const firstId = loopy.start("test-workflow", testInput)
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    // and when step "b" is fixed and the run is rerun from it
    bImpl = () => 2
    const secondId = loopy.rerun(firstId, { from: "b" })
    // then the rerun returns a new ID and succeeds using the reused step "a"
    expect(secondId).not.toBe(firstId)
    expect(await runOutput(loopy, secondId)).toBe(3)
    expect(aCalls).toBe(1)
    // and the second attempt contains both succeeded steps
    const attempt2 = await loopy.runs.get(secondId)
    expect(attempt2.attempt).toBe(2)
    expect(attempt2.steps.map((step) => [step.key, step.status])).toEqual([
        ["a", "succeeded"],
        ["b", "succeeded"]
    ])
})

test("rerun preserves chronological step order across a caught-and-failed step", async () => {
    // given a registered workflow where step "b" fails and is caught before later succeeding steps
    const { loopy } = tempLoopy()
    let bCalls = 0
    register(loopy, async () => {
        await loopy.step("a", z.number(), async () => 1)
        try {
            await loopy.step("b", z.number(), async () => {
                bCalls++
                throw new Error("boom")
            })
        } catch {}
        await loopy.step("c", z.number(), async () => 3)
        await loopy.step("d", z.number(), async () => 4)
        return "done"
    })
    // when the first attempt succeeds and is rerun from the last step
    const firstId = loopy.start("test-workflow", testInput)
    expect(await runOutput(loopy, firstId)).toBe("done")
    const secondId = loopy.rerun(firstId, { from: "d" })
    expect(await runOutput(loopy, secondId)).toBe("done")
    // then the caught failed step is re-executed in place
    expect(bCalls).toBe(2)
    // and the second attempt preserves chronological order and statuses
    const attempt2 = await loopy.runs.get(secondId)
    expect(attempt2.steps.map((step) => step.key)).toEqual(["a", "b", "c", "d"])
    expect(attempt2.steps.map((step) => step.status)).toEqual(["succeeded", "failed", "succeeded", "succeeded"])
})

test("rerun of a succeeded run creates a new attempt", async () => {
    // given a registered succeeded workflow whose second step reads a mutable implementation value
    const { loopy } = tempLoopy()
    let bValue = 2
    register(loopy, async () => {
        const a = await loopy.step("a", z.number(), async () => 1)
        const b = await loopy.step("b", z.number(), async () => bValue)
        return a + b
    })
    const firstId = loopy.start("test-workflow", testInput)
    expect(await runOutput(loopy, firstId)).toBe(3)
    // when the implementation value changes and the run is rerun from step "b"
    bValue = 10
    const secondId = loopy.rerun(firstId, { from: "b" })
    // then a new attempt returns the updated result
    expect(await runOutput(loopy, secondId)).toBe(11)
    expect(await loopy.runs.list()).toHaveLength(2)
})

test("rerun reuses the source attempt input", async () => {
    // given a registered workflow whose first attempt fails after reading its input
    const { loopy } = tempLoopy()
    let shouldFail = true
    register(loopy, async (value) => {
        await loopy.step("input", z.number(), async () => value.value)
        return loopy.step("publish", z.number(), async () => {
            if (shouldFail) throw new Error("boom")
            return value.value
        })
    })
    const firstId = loopy.start("test-workflow", { id: "test-key", value: 17 })
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    // when the run is fixed and rerun without accepting new input
    shouldFail = false
    const secondId = loopy.rerun(firstId, { from: "publish" })
    // then the new attempt executes with the source attempt's persisted input
    expect(await runOutput(loopy, secondId)).toBe(17)
})

test("rerun copies artifacts to the new attempt", async () => {
    // given a registered workflow that writes an artifact before a publish step that initially fails
    const { loopy, dir } = tempLoopy()
    let publishImpl: () => string = () => {
        throw new Error("boom")
    }
    register(loopy, async () => {
        await loopy.artifacts.writeText("report", "hello")
        return loopy.step("publish", z.string(), async () => publishImpl())
    })
    const firstId = loopy.start("test-workflow", testInput)
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    // when publish is fixed and the workflow is rerun from that step
    publishImpl = () => "published"
    const secondId = loopy.rerun(firstId, { from: "publish" })
    expect(await runOutput(loopy, secondId)).toBe("published")
    // then the new attempt has an independently copied artifact
    const attempt1 = await loopy.runs.get(firstId)
    const attempt2 = await loopy.runs.get(secondId)
    expect(attempt2.artifacts).toHaveLength(1)
    expect(await loopy.artifacts.readText(attempt2.artifacts[0].id)).toEqual({ text: "hello" })
    expect(attempt2.artifacts[0].file.startsWith(path.join("artifacts", secondId))).toBe(true)
    expect(attempt2.artifacts[0].file).not.toBe(attempt1.artifacts[0].file)
    expect(fs.existsSync(path.join(dir, attempt1.artifacts[0].file))).toBe(true)
    expect(fs.existsSync(path.join(dir, attempt2.artifacts[0].file))).toBe(true)
    // and the copied artifact step points to the new artifact
    const artifactStep = attempt2.steps.find((step) => step.key === "artifact:report")!
    expect(artifactStep.kind).toBe("artifact")
    if (artifactStep.kind === "artifact") {
        expect(artifactStep.artifactId).toBe(attempt2.artifacts[0].id)
        expect(artifactStep.output).toEqual(attempt2.artifacts[0])
    }
})

test("rerun requires an existing run ID", async () => {
    // given a registered workflow with no prior runs
    const { loopy } = tempLoopy()
    register(loopy, async () => 1)
    // when rerun is called with an unknown ID
    // then it is rejected because the run does not exist
    expect(() => loopy.rerun("missing", { from: "a" })).toThrow(/not found/)
})

test("rerun from an unknown step is rejected", async () => {
    // given a registered workflow with a failed attempt
    const { loopy } = tempLoopy()
    register(loopy, async () => {
        throw new Error("boom")
    })
    const firstId = loopy.start("test-workflow", testInput)
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    // when rerun targets a step that never existed
    // then it is rejected without creating an attempt
    expect(() => loopy.rerun(firstId, { from: "nope" })).toThrow(/not found/)
    expect(await loopy.runs.list()).toHaveLength(1)
})

test("rerun while the run is active is rejected", async () => {
    // given a registered workflow that remains active on a gate
    const { loopy } = tempLoopy()
    const parked = gate()
    register(loopy, async () => {
        await parked.released
        return 1
    })
    const firstId = loopy.start("test-workflow", testInput)
    // when rerun is requested while the source is active
    // then it is rejected due to concurrent attempts
    expect(() => loopy.rerun(firstId, { from: "a" })).toThrow(/concurrent attempts/)
    // and the original run is allowed to complete
    parked.release()
    expect(await runOutput(loopy, firstId)).toBe(1)
})

test("rerun of an interrupted run is rejected", async () => {
    // given an interrupted registered workflow on a reopened Loopy instance
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    register(loopy, async () => {
        await loopy.step("a", z.number(), async () => 1)
        reached.release()
        await parked.released
    })
    const firstId = loopy.start("test-workflow", testInput)
    await reached.released
    const second = reopen()
    register(second, async () => 1)
    // when rerun is requested against the persisted interrupted attempt
    // then it is rejected due to concurrent attempts
    expect(() => second.rerun(firstId, { from: "a" })).toThrow(/concurrent attempts/)
})

test("rerun of a non-latest attempt is rejected", async () => {
    // given a registered workflow with two completed attempts
    const { loopy } = tempLoopy()
    let shouldFail = true
    register(loopy, async () =>
        loopy.step("publish", z.string(), async () => {
            if (shouldFail) throw new Error("boom")
            return "published"
        })
    )
    const firstId = loopy.start("test-workflow", testInput)
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    shouldFail = false
    const secondId = loopy.rerun(firstId, { from: "publish" })
    expect(await runOutput(loopy, secondId)).toBe("published")
    // when rerun targets the older first attempt
    // then it is rejected because only the latest attempt is eligible
    expect(() => loopy.rerun(firstId, { from: "publish" })).toThrow(/not the latest attempt/)
})

test("rerun validates persisted input before creating an attempt", async () => {
    // given a succeeded workflow whose current registration no longer accepts its persisted input
    const { loopy, reopen } = tempLoopy()
    register(loopy, async () => loopy.step("publish", z.string(), async () => "published"))
    const firstId = loopy.start("test-workflow", testInput)
    expect(await runOutput(loopy, firstId)).toBe("published")
    const second = reopen()
    second.registerWorkflow(
        "test-workflow",
        {
            input: z.object({ id: z.string(), value: z.string() }),
            output: z.string(),
            key: (value) => value.id
        },
        async () => "published"
    )

    // when rerun validates the source input against the changed registration
    // then it rejects before inserting another attempt
    expect(() => second.rerun(firstId, { from: "publish" })).toThrow()
    expect(await second.runs.list()).toHaveLength(1)
})
