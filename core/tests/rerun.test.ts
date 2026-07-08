import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { gate, tempLoopy, testRun } from "@loopy/test-utils"

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

test("run of a failed key without rerun options is an error", async () => {
    // given a loopy instance
    const { loopy } = tempLoopy()
    // when the run body throws
    // then the run fails with the thrown error
    await expect(
        testRun(loopy, async () => {
            throw new Error("boom")
        })
    ).rejects.toThrow("boom")
    // and when the same key is run again without rerun options
    // then it is rejected because the key has already failed
    await expect(testRun(loopy, async () => "fine")).rejects.toThrow(/has failed/)
})

test("rerun from a step starts a new attempt reusing earlier steps", async () => {
    // given a body with step "a" that always succeeds and step "b" whose impl can be swapped
    const { loopy } = tempLoopy()
    let aCalls = 0
    let bImpl: () => number = () => {
        throw new Error("boom")
    }
    const body = async () => {
        const a = await loopy.step("a", z.number(), async () => {
            aCalls++
            return 1
        })
        const b = await loopy.step("b", z.number(), async () => bImpl())
        return a + b
    }
    // when the run executes and step "b" fails
    // then the run fails with the thrown error
    await expect(testRun(loopy, body)).rejects.toThrow("boom")
    // and when step "b" is fixed and the run is rerun from "b"
    bImpl = () => 2
    // then the rerun succeeds, combining the reused step "a" with the new step "b"
    expect(await testRun(loopy, body, { from: "b" })).toBe(3)
    // and step "a" was not re-executed
    expect(aCalls).toBe(1)
    // and two attempts are recorded for the key
    const runs = await loopy.runs.list({ key: "test-key" })
    expect(runs.map((r) => r.attempt).sort()).toEqual([1, 2])
    // and the second attempt succeeded with both steps marked succeeded
    const attempt2 = await loopy.runs.get(runs.find((r) => r.attempt === 2)!.id)
    expect(attempt2.status).toBe("succeeded")
    expect(attempt2.steps.map((s) => [s.key, s.status])).toEqual([
        ["a", "succeeded"],
        ["b", "succeeded"]
    ])
})

test("rerun preserves chronological step order across a caught-and-failed step", async () => {
    // given a body where step "b" fails and is caught, followed by succeeding steps "c" and "d"
    const { loopy } = tempLoopy()
    let bCalls = 0
    const body = async () => {
        await loopy.step("a", z.number(), async () => 1)
        try {
            await loopy.step("b", z.number(), async () => {
                bCalls++
                throw new Error("boom")
            })
        } catch {
            // the workflow tolerates step "b" failing and continues
        }
        await loopy.step("c", z.number(), async () => 3)
        await loopy.step("d", z.number(), async () => 4)
        return "done"
    }
    // when the run executes and completes despite step "b" failing
    expect(await testRun(loopy, body)).toBe("done")
    // and when the run is rerun from the last step "d"
    expect(await testRun(loopy, body, { from: "d" })).toBe("done")
    // then the caught-and-failed step "b" was re-executed in place, not treated as reusable
    expect(bCalls).toBe(2)
    // and the second attempt's steps stay in chronological order a, b, c, d
    const runs = await loopy.runs.list({ key: "test-key" })
    const attempt2 = await loopy.runs.get(runs.find((r) => r.attempt === 2)!.id)
    expect(attempt2.steps.map((s) => s.key)).toEqual(["a", "b", "c", "d"])
    expect(attempt2.steps.map((s) => s.status)).toEqual(["succeeded", "failed", "succeeded", "succeeded"])
})

test("rerun of a succeeded run creates a new attempt", async () => {
    // given a body with steps "a" and "b", where "b" reads a mutable outer value
    const { loopy } = tempLoopy()
    let bValue = 2
    const body = async () => {
        const a = await loopy.step("a", z.number(), async () => 1)
        const b = await loopy.step("b", z.number(), async () => bValue)
        return a + b
    }
    // when the run executes successfully
    // then it returns the sum of the two steps
    expect(await testRun(loopy, body)).toBe(3)
    // and when the outer value changes and the run is rerun from "b"
    bValue = 10
    // then the rerun returns the updated sum
    expect(await testRun(loopy, body, { from: "b" })).toBe(11)
    // and two attempts are recorded
    expect(await loopy.runs.list()).toHaveLength(2)
})

test("rerun copies artifacts to the new attempt", async () => {
    // given a body that writes an artifact and then runs a "publish" step that can be made to fail
    const { loopy, dir } = tempLoopy()
    let publishImpl: () => string = () => {
        throw new Error("boom")
    }
    const body = async () => {
        await loopy.artifacts.writeText("report", "hello")
        return loopy.step("publish", z.string(), async () => publishImpl())
    }
    // when the run executes and the "publish" step fails
    // then the run fails with the thrown error
    await expect(testRun(loopy, body)).rejects.toThrow("boom")
    // and when "publish" is fixed and the run is rerun from "publish"
    publishImpl = () => "published"
    // then the rerun succeeds with the published value
    expect(await testRun(loopy, body, { from: "publish" })).toBe("published")
    // and the new attempt has the artifact copied over with its content readable
    const runs = await loopy.runs.list({ key: "test-key" })
    const attempt1 = await loopy.runs.get(runs.find((r) => r.attempt === 1)!.id)
    const attempt2 = await loopy.runs.get(runs.find((r) => r.attempt === 2)!.id)
    expect(attempt2.artifacts).toHaveLength(1)
    expect(await loopy.artifacts.readText(attempt2.artifacts[0].id)).toEqual({ text: "hello" })
    // and the copied artifact's file lives under the new attempt's run directory, not the previous run's
    expect(attempt2.artifacts[0].file.startsWith(path.join("artifacts", attempt2.id))).toBe(true)
    expect(attempt2.artifacts[0].file).not.toBe(attempt1.artifacts[0].file)
    // and both attempts' files exist independently on disk
    expect(fs.existsSync(path.join(dir, attempt1.artifacts[0].file))).toBe(true)
    expect(fs.existsSync(path.join(dir, attempt2.artifacts[0].file))).toBe(true)
    // and the artifact step reflects the copied artifact, including its new file path
    const artifactStep = attempt2.steps.find((s) => s.key === "artifact:report")!
    expect(artifactStep.kind).toBe("artifact")
    if (artifactStep.kind === "artifact") {
        expect(artifactStep.artifactId).toBe(attempt2.artifacts[0].id)
        expect(artifactStep.output).toEqual(attempt2.artifacts[0])
    }
})

test("rerun requires an existing run", async () => {
    // given a loopy instance with no prior runs
    const { loopy } = tempLoopy()
    // when a rerun is attempted from a step with no existing run
    // then it is rejected because no run is found
    await expect(testRun(loopy, async () => 1, { from: "a" })).rejects.toThrow(/No run found/)
})

test("rerun from an unknown step is rejected", async () => {
    // given a loopy instance
    const { loopy } = tempLoopy()
    // when the run executes and fails
    // then the run fails with the thrown error
    await expect(
        testRun(loopy, async () => {
            throw new Error("boom")
        })
    ).rejects.toThrow("boom")
    // and when a rerun is attempted from a step that never existed
    // then it is rejected because the step is not found
    await expect(testRun(loopy, async () => 1, { from: "nope" })).rejects.toThrow(/not found/)
})

test("rerun while the run is active is rejected", async () => {
    // given a gated body and a first run that blocks on the gate
    const { loopy } = tempLoopy()
    const parked = gate()
    const first = testRun(loopy, async () => {
        await parked.released
        return 1
    })
    // when a rerun is attempted while the first run is still active
    // then it is rejected due to concurrent attempts
    await expect(testRun(loopy, async () => 2, { from: "a" })).rejects.toThrow(/concurrent attempts/)
    // and the first run is allowed to complete
    parked.release()
    await first
})

test("rerun of an interrupted run is rejected", async () => {
    // given a loopy instance and gates to control the run and observe when step "a" completes
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    // when the run executes step "a" and then blocks indefinitely, simulating an interruption
    testRun(loopy, async () => {
        await loopy.step("a", z.number(), async () => 1)
        reached.release()
        await parked.released
    }).catch(() => {})
    await reached.released
    // and when a rerun from "a" is attempted against a reopened loopy instance
    const second = reopen()
    // then it is rejected due to concurrent attempts
    await expect(testRun(second, async () => 1, { from: "a" })).rejects.toThrow(/concurrent attempts/)
})
