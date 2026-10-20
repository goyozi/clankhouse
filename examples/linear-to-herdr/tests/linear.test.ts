import { gate } from "@clankhouse/testing"
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest"
import { type IssueQuery, type Linear, type LinearIssue, linearIssues } from "../src/linear"
import { issue } from "./fakes"

type Recorded = { emitted: LinearIssue[]; failures: unknown[] }

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

test("polls right away and on its interval, passing the state and team", async () => {
    // given a client returning one issue
    const queries: IssueQuery[] = []
    const client = scriptedLinear(async (query) => {
        queries.push(query)
        return [issue()]
    })

    // when the event source starts
    const recorded = startSource(client, { state: "Todo", team: "ENG", intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)

    // then it polls right away with the state and team
    expect(queries).toEqual([{ state: "Todo", team: "ENG" }])
    expect(recorded.emitted).toEqual([issue()])

    // when the interval passes twice
    await vi.advanceTimersByTimeAsync(2_000)

    // then it polls on each interval and emits the issue every time
    expect(queries).toHaveLength(3)
    expect(recorded.emitted).toEqual([issue(), issue(), issue()])
})

test("skips a poll while the previous one is still running", async () => {
    // given a client whose first poll hangs
    const firstPoll = gate()
    let polls = 0
    const client = scriptedLinear(async () => {
        polls++
        if (polls === 1) await firstPoll.released
        return [issue()]
    })
    const recorded = startSource(client, { state: "Todo", intervalMs: 1_000 })

    // when two intervals pass during the first poll
    await vi.advanceTimersByTimeAsync(2_000)

    // then no other poll starts
    expect(polls).toBe(1)

    // when the first poll finishes and the next interval passes
    firstPoll.release()
    await vi.advanceTimersByTimeAsync(1_000)

    // then polling resumes
    expect(polls).toBe(2)
    expect(recorded.emitted).toHaveLength(2)
})

test("reports a failed poll and keeps polling", async () => {
    // given a client whose first poll fails
    const failure = new Error("Linear API responded with 500 Internal Server Error")
    let polls = 0
    const client = scriptedLinear(async () => {
        polls++
        if (polls === 1) throw failure
        return [issue()]
    })

    // when the event source starts and one interval passes
    const recorded = startSource(client, { state: "Todo", intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)

    // then the failure is reported
    expect(recorded.failures).toEqual([failure])
    // and the next poll emits the issue
    expect(polls).toBe(2)
    expect(recorded.emitted).toEqual([issue()])
})

test("stops polling after stop()", async () => {
    // given a running event source
    let polls = 0
    const client = scriptedLinear(async () => {
        polls++
        return []
    })
    const handle = linearIssues(client, { state: "Todo", intervalMs: 1_000 }).start({
        emit: () => {},
        fail: () => {}
    })
    await vi.advanceTimersByTimeAsync(0)

    // when it is stopped and intervals pass
    handle.stop()
    await vi.advanceTimersByTimeAsync(5_000)

    // then it doesn't poll again
    expect(polls).toBe(1)
})

function scriptedLinear(assignedIssues: Linear["assignedIssues"]): Linear {
    return {
        assignedIssues,
        moveIssue: async () => {}
    }
}

function startSource(client: Linear, options: Parameters<typeof linearIssues>[1]): Recorded {
    const recorded: Recorded = { emitted: [], failures: [] }
    const handle = linearIssues(client, options).start({
        emit: (issue) => recorded.emitted.push(issue),
        fail: (error) => recorded.failures.push(error)
    })
    onTestFinished(() => handle.stop())
    return recorded
}
