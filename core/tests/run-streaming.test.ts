import * as z from "zod"
import { expect, test } from "vitest"
import { BaseLanguageModel, type LanguageModelInvocation } from "@loopy/core/ai/base-llm"
import { LoopyError } from "@loopy/core/errors"
import { gate, tempLoopy, testRun } from "@loopy/test-utils"
import type { Loopy } from "@loopy/core/loopy"

async function onlyRunId(loopy: Loopy, key?: string): Promise<string> {
    const runs = await loopy.runs.list(key !== undefined ? { key } : undefined)
    expect(runs).toHaveLength(1)
    return runs[0]!.id
}

test("stream on a finished run yields each step once in order and ends", async () => {
    // given a succeeded run with two steps
    const { loopy } = tempLoopy()
    await testRun(
        loopy,
        async () => {
            await loopy.step("one", z.string(), async () => "1")
            await loopy.step("two", z.string(), async () => "2")
        },
        { output: z.void() }
    )
    const runId = await onlyRunId(loopy)

    // when streaming the run
    const items = await Array.fromAsync(loopy.runs.stream(runId))

    // then each step is yielded exactly once, in seq order, in its terminal state
    const steps = items.filter((i) => "kind" in i)
    expect(steps.map((s) => [s.name, s.status])).toEqual([
        ["one", "succeeded"],
        ["two", "succeeded"]
    ])
    // and the succeeded run metadata is the final item
    expect(items.at(-1)).toMatchObject({ id: runId, status: "succeeded" })
})

test("stream tails a live run through step transitions until the run ends", async () => {
    // given a run with two gated steps
    const { loopy } = tempLoopy()
    const g1 = gate()
    const g2 = gate()
    const done = testRun(
        loopy,
        async () => {
            await loopy.step("one", z.string(), async () => {
                await g1.released
                return "1"
            })
            await loopy.step("two", z.string(), async () => {
                await g2.released
                return "2"
            })
        },
        { output: z.void() }
    )
    const runId = await onlyRunId(loopy)

    // when streaming the run
    const stream = loopy.runs.stream(runId)

    // then the first step is observed as running
    expect((await stream.next()).value).toMatchObject({ name: "one", status: "running" })

    // when the first step completes while a read is pending
    let pending = stream.next()
    g1.release()

    // then its succeeded snapshot is yielded
    expect((await pending).value).toMatchObject({ name: "one", status: "succeeded" })
    // and the second step is observed as running
    expect((await stream.next()).value).toMatchObject({ name: "two", status: "running" })

    // when the second step completes
    pending = stream.next()
    g2.release()

    // then its succeeded snapshot is yielded
    expect((await pending).value).toMatchObject({ name: "two", status: "succeeded" })

    // and the succeeded run metadata is delivered once the run finishes
    await done
    expect((await stream.next()).value).toMatchObject({ id: runId, status: "succeeded" })
    // and the stream ends
    expect((await stream.next()).done).toBe(true)
})

test("stream exposes a failed step's LoopyError code", async () => {
    // given a live durable step that will fail with a coded error
    const { loopy } = tempLoopy()
    const parked = gate()
    const done = testRun(loopy, async () =>
        loopy.step("coded", z.never(), async () => {
            await parked.released
            throw new LoopyError("ai_output_invalid", "invalid output")
        })
    )
    const runId = await onlyRunId(loopy)
    const stream = loopy.runs.stream(runId)
    expect((await stream.next()).value).toMatchObject({ name: "coded", status: "running" })

    // when the step fails while the stream is waiting
    const pending = stream.next()
    parked.release()

    // then the failed snapshot includes the stable code
    expect((await pending).value).toMatchObject({
        name: "coded",
        status: "failed",
        error: "invalid output",
        errorCode: "ai_output_invalid"
    })
    await expect(done).rejects.toThrow("invalid output")
})

test("stream with fromStepId on a finished run re-yields that step and everything after", async () => {
    // given a succeeded run with three steps
    const { loopy } = tempLoopy()
    await testRun(
        loopy,
        async () => {
            await loopy.step("one", z.string(), async () => "1")
            await loopy.step("two", z.string(), async () => "2")
            await loopy.step("three", z.string(), async () => "3")
        },
        { output: z.void() }
    )
    const runId = await onlyRunId(loopy)
    const run = await loopy.runs.get(runId)

    // when streaming from the second step's id
    const items = await Array.fromAsync(loopy.runs.stream(runId, { fromStepId: run.steps[1]!.id }))

    // then the from-step is included in its current state along with everything after
    const steps = items.filter((i) => "kind" in i)
    expect(steps.map((s) => [s.name, s.status])).toEqual([
        ["two", "succeeded"],
        ["three", "succeeded"]
    ])
    // and the succeeded run metadata is the final item
    expect(items.at(-1)).toMatchObject({ id: runId, status: "succeeded" })
})

test("stream with fromStepId on a live run resumes from the snapshot's last step", async () => {
    // given a run whose first step succeeded and second step is parked
    const { loopy } = tempLoopy()
    const parked = gate()
    const reached = gate()
    const done = testRun(
        loopy,
        async () => {
            await loopy.step("one", z.string(), async () => "1")
            await loopy.step("two", z.string(), async () => {
                reached.release()
                await parked.released
                return "2"
            })
        },
        { output: z.void() }
    )
    await reached.released
    const runId = await onlyRunId(loopy)
    const snapshot = await loopy.runs.get(runId)

    // when streaming from the first step's id
    const stream = loopy.runs.stream(runId, { fromStepId: snapshot.steps[0]!.id })

    // then the from-step is re-yielded in its current state
    expect((await stream.next()).value).toMatchObject({ name: "one", status: "succeeded" })
    // and the parked step is observed as running
    expect((await stream.next()).value).toMatchObject({ name: "two", status: "running" })

    // when the parked step completes
    const pending = stream.next()
    parked.release()

    // then its succeeded snapshot is yielded, followed by the succeeded run metadata
    expect((await pending).value).toMatchObject({ name: "two", status: "succeeded" })
    await done
    expect((await stream.next()).value).toMatchObject({ id: runId, status: "succeeded" })
    // and the stream ends
    expect((await stream.next()).done).toBe(true)
})

class ParkingLLM extends BaseLanguageModel {
    readonly client = "fake-llm"
    readonly provider = "fake"
    readonly model = "parking"

    constructor(
        private readonly reached: () => void,
        private readonly parked: Promise<void>
    ) {
        super()
    }

    protected async invoke({ prompt, session }: LanguageModelInvocation): Promise<unknown> {
        session.addMessage("user", prompt)
        this.reached()
        await this.parked
        return { summary: "s" }
    }
}

test("stream yields a running llm step with its sessionId set mid-flight", async () => {
    // given a run with an llm call that parks mid-invocation
    const { loopy } = tempLoopy()
    const parked = gate()
    const reached = gate()
    const llm = new ParkingLLM(reached.release, parked.released)
    const done = testRun(loopy, async () =>
        llm.call("summarize", { prompt: "p", output: z.object({ summary: z.string() }) })
    )
    await reached.released
    const runId = await onlyRunId(loopy)

    // when streaming the run while the llm step is parked
    const stream = loopy.runs.stream(runId)
    const first = (await stream.next()).value

    // then the running llm step already carries its sessionId
    expect(first).toMatchObject({ kind: "llm", status: "running", sessionId: expect.any(String) })

    // when the llm call completes
    const pending = stream.next()
    parked.release()

    // then the succeeded snapshot still carries the same sessionId
    expect((await pending).value).toMatchObject({
        kind: "llm",
        status: "succeeded",
        sessionId: (first as { sessionId?: string }).sessionId
    })

    // and the succeeded run metadata is delivered once the run finishes
    await done
    expect((await stream.next()).value).toMatchObject({ id: runId, status: "succeeded" })
    // and the stream ends
    expect((await stream.next()).done).toBe(true)
})

test("stream yields a failed step with its error and ends when the run fails", async () => {
    // given a run with a gated step that throws
    const { loopy } = tempLoopy()
    const parked = gate()
    const done = testRun(loopy, async () => {
        await loopy.step("boom", z.string(), async () => {
            await parked.released
            throw new Error("kaboom")
        })
    })
    done.catch(() => {})
    const runId = await onlyRunId(loopy)

    // when streaming the run
    const stream = loopy.runs.stream(runId)

    // then the step is observed as running
    expect((await stream.next()).value).toMatchObject({ name: "boom", status: "running" })

    // when the step fails
    const pending = stream.next()
    parked.release()

    // then the failed snapshot carries the error
    expect((await pending).value).toMatchObject({ name: "boom", status: "failed", error: "kaboom" })

    // and the failed run metadata is delivered once the run fails
    await expect(done).rejects.toThrow("kaboom")
    expect((await stream.next()).value).toMatchObject({ id: runId, status: "failed" })
    // and the stream ends
    expect((await stream.next()).done).toBe(true)
})

test("stream on a missing run throws", async () => {
    // given no run with the given id
    const { loopy } = tempLoopy()

    // when streaming an unknown run id
    // then it throws a not found error
    await expect(loopy.runs.stream("nope").next()).rejects.toMatchObject({
        message: expect.stringMatching(/not found/),
        code: "workflow_run_not_found"
    })
})

test("stream with an unknown or foreign fromStepId throws", async () => {
    // given two succeeded runs with one step each
    const { loopy } = tempLoopy()
    await testRun(loopy, async () => loopy.step("one", z.string(), async () => "1"), { key: "a" })
    await testRun(loopy, async () => loopy.step("one", z.string(), async () => "1"), { key: "b" })
    const runA = await onlyRunId(loopy, "a")
    const runB = await onlyRunId(loopy, "b")
    const foreignStepId = (await loopy.runs.get(runB)).steps[0]!.id

    // when streaming with an unknown fromStepId
    // then it throws a step not found error
    await expect(loopy.runs.stream(runA, { fromStepId: "nope" }).next()).rejects.toMatchObject({
        message: expect.stringMatching(/Step not found/),
        code: "workflow_step_not_found"
    })
    // and when streaming with another run's step id
    // then it also throws a step not found error
    await expect(loopy.runs.stream(runA, { fromStepId: foreignStepId }).next()).rejects.toMatchObject({
        message: expect.stringMatching(/Step not found/),
        code: "workflow_step_not_found"
    })
})

test("stream on an interrupted run after a crash drains persisted steps and ends", async () => {
    // given a run whose second step is parked when the process crashes
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    testRun(
        loopy,
        async () => {
            await loopy.step("one", z.string(), async () => "1")
            await loopy.step("two", z.string(), async () => {
                reached.release()
                await parked.released
                return "2"
            })
        },
        { output: z.void() }
    ).catch(() => {})
    await reached.released
    const runId = await onlyRunId(loopy)

    // when reopening loopy and streaming the run
    const second = reopen()
    const items = await Array.fromAsync(second.runs.stream(runId))

    // then the persisted step states are drained and the stream completes
    const steps = items.filter((i) => "kind" in i)
    expect(steps.map((s) => [s.name, s.status])).toEqual([
        ["one", "succeeded"],
        ["two", "interrupted"]
    ])
    // and the interrupted run metadata is the final item
    expect(items.at(-1)).toMatchObject({ id: runId, status: "interrupted" })
})

test("stream handles concurrent steps completing out of seq order", async () => {
    // given a run executing two gated steps concurrently
    const { loopy } = tempLoopy()
    const g1 = gate()
    const g2 = gate()
    const done = testRun(
        loopy,
        async () => {
            await Promise.all([
                loopy.step("one", z.string(), async () => {
                    await g1.released
                    return "1"
                }),
                loopy.step("two", z.string(), async () => {
                    await g2.released
                    return "2"
                })
            ])
        },
        { output: z.void() }
    )
    const runId = await onlyRunId(loopy)

    // when streaming the run
    const stream = loopy.runs.stream(runId)

    // then both steps are observed as running
    expect((await stream.next()).value).toMatchObject({ name: "one", status: "running" })
    expect((await stream.next()).value).toMatchObject({ name: "two", status: "running" })

    // when the later-seq step completes first
    let pending = stream.next()
    g2.release()

    // then its succeeded snapshot is yielded
    expect((await pending).value).toMatchObject({ name: "two", status: "succeeded" })

    // when the earlier-seq step completes
    pending = stream.next()
    g1.release()

    // then its succeeded snapshot is yielded, followed by the succeeded run metadata
    expect((await pending).value).toMatchObject({ name: "one", status: "succeeded" })
    await done
    expect((await stream.next()).value).toMatchObject({ id: runId, status: "succeeded" })
    // and the stream ends
    expect((await stream.next()).done).toBe(true)
})

test("stream keeps tailing an orphaned concurrent step after the run has failed", async () => {
    // given a run whose two concurrent steps are one that throws and one that is gated
    const { loopy } = tempLoopy()
    const boom = gate()
    const parked = gate()
    const done = testRun(
        loopy,
        async () => {
            await Promise.all([
                loopy.step("boom", z.string(), async () => {
                    await boom.released
                    throw new Error("kaboom")
                }),
                loopy.step("slow", z.string(), async () => {
                    await parked.released
                    return "s"
                })
            ])
        },
        { output: z.void() }
    )
    done.catch(() => {})
    const runId = await onlyRunId(loopy)

    // when streaming the run and both steps are observed running
    const stream = loopy.runs.stream(runId)
    expect((await stream.next()).value).toMatchObject({ name: "boom", status: "running" })
    expect((await stream.next()).value).toMatchObject({ name: "slow", status: "running" })

    // when the first step throws, failing the run while its sibling keeps executing
    let pending = stream.next()
    boom.release()

    // then the failed step is delivered and the run reports failure
    expect((await pending).value).toMatchObject({ name: "boom", status: "failed", error: "kaboom" })
    await expect(done).rejects.toThrow("kaboom")

    // and the failed run metadata is delivered while the orphaned step is still running
    expect((await stream.next()).value).toMatchObject({ id: runId, status: "failed" })

    // when a read is pending and the stream has reached its end-or-wait decision with the run inactive
    pending = stream.next()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // and the orphaned sibling only then succeeds
    parked.release()

    // then its terminal snapshot is still delivered before the stream ends
    expect((await pending).value).toMatchObject({ name: "slow", status: "succeeded" })
    expect((await stream.next()).done).toBe(true)
})

test("stream ends promptly when its abort signal fires while tailing a live run", async () => {
    // given a live run parked on a gated step
    const { loopy } = tempLoopy()
    const parked = gate()
    const done = testRun(
        loopy,
        async () => {
            await loopy.step("one", z.string(), async () => {
                await parked.released
                return "1"
            })
        },
        { output: z.void() }
    )
    const runId = await onlyRunId(loopy)
    const controller = new AbortController()

    // when streaming with the abort signal and observing the running step
    const stream = loopy.runs.stream(runId, { signal: controller.signal })
    expect((await stream.next()).value).toMatchObject({ name: "one", status: "running" })

    // when the signal aborts while the step is still parked
    const pending = stream.next()
    controller.abort()

    // then the stream ends without waiting for the run to finish
    expect((await pending).done).toBe(true)

    // and the underlying run still runs to completion
    parked.release()
    await done
})

test("stream observes a failed step being re-executed on resume", async () => {
    // given a crashed run with a succeeded step, a failed-but-caught step, and a parked step
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    testRun(
        loopy,
        async () => {
            await loopy.step("a", z.string(), async () => "va")
            try {
                await loopy.step("b", z.string(), async () => {
                    throw new Error("first try")
                })
            } catch {}
            await loopy.step("c", z.string(), async () => {
                reached.release()
                await parked.released
                return "vc"
            })
        },
        { output: z.void() }
    ).catch(() => {})
    await reached.released
    const runId = await onlyRunId(loopy)

    // when resuming the run on a reopened loopy, parked before touching any step
    const second = reopen()
    const resumeGate = gate()
    const done = testRun(
        second,
        async () => {
            await resumeGate.released
            await second.step("a", z.string(), async () => "va")
            await second.step("b", z.string(), async () => "vb")
            await second.step("c", z.string(), async () => "vc")
        },
        { output: z.void() }
    )

    // and streaming the resumed run before it makes progress
    const stream = second.runs.stream(runId)

    // then the initial drain yields the persisted step states
    expect((await stream.next()).value).toMatchObject({ name: "a", status: "succeeded" })
    expect((await stream.next()).value).toMatchObject({ name: "b", status: "failed" })
    expect((await stream.next()).value).toMatchObject({ name: "c", status: "interrupted" })

    // when the resumed body re-executes the non-succeeded steps
    const pending = stream.next()
    resumeGate.release()

    // then the previously failed step is observed running again
    expect((await pending).value).toMatchObject({ name: "b", status: "running" })

    // and the remaining yields include both re-executed steps succeeding
    const rest = await Array.fromAsync(stream)
    await done
    const restSteps = rest.filter((s) => "kind" in s)
    expect(restSteps.some((s) => s.name === "b" && s.status === "succeeded")).toBe(true)
    expect(restSteps.some((s) => s.name === "c" && s.status === "succeeded")).toBe(true)
    // and the replayed succeeded step is never re-yielded
    expect(restSteps.every((s) => s.name !== "a")).toBe(true)
    // and the succeeded run metadata is delivered exactly once, as the final item
    expect(rest.at(-1)).toMatchObject({ id: runId, status: "succeeded" })
    expect(rest.filter((s) => !("kind" in s))).toHaveLength(1)
})

test("an aborted stream delivers no run metadata even after the run finishes", async () => {
    // given a live run parked on a gated step
    const { loopy } = tempLoopy()
    const parked = gate()
    const done = testRun(
        loopy,
        async () => {
            await loopy.step("one", z.string(), async () => {
                await parked.released
                return "1"
            })
        },
        { output: z.void() }
    )
    const runId = await onlyRunId(loopy)
    const controller = new AbortController()

    // when streaming with the abort signal and observing the running step
    const stream = loopy.runs.stream(runId, { signal: controller.signal })
    expect((await stream.next()).value).toMatchObject({ name: "one", status: "running" })

    // when the signal aborts while the step is still parked
    controller.abort()

    // then the stream ends without a run item
    expect((await stream.next()).done).toBe(true)

    // and no run metadata arrives even after the run finishes
    parked.release()
    await done
    expect((await stream.next()).done).toBe(true)
})

test("an aborted stream stops mid-batch and withholds run metadata bundled behind a step", async () => {
    // given a run that has already completed, so its first drain bundles the step and run metadata in one batch
    const { loopy } = tempLoopy()
    await testRun(
        loopy,
        async () => {
            await loopy.step("one", z.string(), async () => "1")
        },
        { output: z.void() }
    )
    const runId = await onlyRunId(loopy)
    const controller = new AbortController()

    // when streaming with the abort signal and pulling the first item of the bundled batch
    const stream = loopy.runs.stream(runId, { signal: controller.signal })
    expect((await stream.next()).value).toMatchObject({ name: "one", status: "succeeded" })

    // when the signal aborts before the bundled run metadata is pulled
    controller.abort()

    // then the stream ends mid-batch without ever delivering the run metadata
    expect((await stream.next()).done).toBe(true)
})

test("stream reports an interrupted run and keeps tailing when it is resumed mid-stream", async () => {
    // given a run whose second step is parked when the process crashes
    const { loopy, reopen } = tempLoopy()
    const parked = gate()
    const reached = gate()
    testRun(
        loopy,
        async () => {
            await loopy.step("one", z.string(), async () => "1")
            await loopy.step("two", z.string(), async () => {
                reached.release()
                await parked.released
                return "2"
            })
        },
        { output: z.void() }
    ).catch(() => {})
    await reached.released
    const runId = await onlyRunId(loopy)

    // when reopening loopy and streaming the run
    const second = reopen()
    const stream = second.runs.stream(runId)

    // then the persisted step states are drained
    expect((await stream.next()).value).toMatchObject({ name: "one", status: "succeeded" })
    expect((await stream.next()).value).toMatchObject({ name: "two", status: "interrupted" })

    // when the run is resumed before the next pull
    const resumed = gate()
    const done = testRun(
        second,
        async () => {
            await second.step("one", z.string(), async () => "1")
            await second.step("two", z.string(), async () => {
                await resumed.released
                return "2"
            })
        },
        { output: z.void() }
    )

    // then the interrupted run metadata is still delivered
    expect((await stream.next()).value).toMatchObject({ id: runId, status: "interrupted" })
    // and the resumed step is observed running without a duplicate run item
    expect((await stream.next()).value).toMatchObject({ name: "two", status: "running" })

    // when the resumed step completes
    const pending = stream.next()
    resumed.release()

    // then its succeeded snapshot is yielded, followed by the succeeded run metadata
    expect((await pending).value).toMatchObject({ name: "two", status: "succeeded" })
    await done
    expect((await stream.next()).value).toMatchObject({ id: runId, status: "succeeded" })
    // and the stream ends
    expect((await stream.next()).done).toBe(true)
})
