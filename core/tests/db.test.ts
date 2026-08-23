import { expect, test } from "vitest"
import * as sql from "@clankhouse/core/db"
import type { RunRow } from "@clankhouse/core/db"
import { tempClankHouse } from "@clankhouse/test-utils"

function runRow(overrides: Partial<RunRow> & Pick<RunRow, "id">): RunRow {
    return {
        key: overrides.id,
        attempt: 1,
        workflow_name: "wf",
        input: null,
        output: null,
        error: null,
        error_code: null,
        status: "succeeded",
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: null,
        ...overrides
    }
}

test("listRuns without filter returns all runs ordered by started_at desc, attempt desc", () => {
    // given four runs with varying started_at times and one repeated key with a higher attempt
    const { clankhouse } = tempClankHouse()
    sql.insertRun(clankhouse.db, runRow({ id: "a", started_at: "2026-01-01T00:00:00.000Z" }))
    sql.insertRun(clankhouse.db, runRow({ id: "b", started_at: "2026-01-03T00:00:00.000Z" }))
    sql.insertRun(clankhouse.db, runRow({ id: "c", key: "b", attempt: 2, started_at: "2026-01-03T00:00:00.000Z" }))
    sql.insertRun(clankhouse.db, runRow({ id: "d", started_at: "2026-01-02T00:00:00.000Z" }))

    // when listing runs with no filter
    // then runs are ordered by started_at desc, then attempt desc
    expect(sql.listRuns(clankhouse.db, {}).map((r) => r.id)).toEqual(["c", "b", "d", "a"])
})

test("listRuns filters by key", () => {
    // given two runs with different keys
    const { clankhouse } = tempClankHouse()
    sql.insertRun(clankhouse.db, runRow({ id: "a", key: "k1" }))
    sql.insertRun(clankhouse.db, runRow({ id: "b", key: "k2" }))

    // when listing runs filtered by key "k1"
    // then only the matching run is returned
    expect(sql.listRuns(clankhouse.db, { key: "k1" }).map((r) => r.id)).toEqual(["a"])
})

test("listRuns filters by workflow name", () => {
    // given two runs with different workflow names
    const { clankhouse } = tempClankHouse()
    sql.insertRun(clankhouse.db, runRow({ id: "a", workflow_name: "wf1" }))
    sql.insertRun(clankhouse.db, runRow({ id: "b", workflow_name: "wf2" }))

    // when listing runs filtered by workflow name "wf2"
    // then only the matching run is returned
    expect(sql.listRuns(clankhouse.db, { workflowName: "wf2" }).map((r) => r.id)).toEqual(["b"])
})

test("listRuns filters by one or many statuses", () => {
    // given three runs with different statuses
    const { clankhouse } = tempClankHouse()
    sql.insertRun(clankhouse.db, runRow({ id: "a", status: "succeeded" }))
    sql.insertRun(clankhouse.db, runRow({ id: "b", status: "failed" }))
    sql.insertRun(clankhouse.db, runRow({ id: "c", status: "interrupted" }))

    // when listing runs filtered by a single status
    // then only the matching run is returned
    expect(sql.listRuns(clankhouse.db, { statuses: ["failed"] }).map((r) => r.id)).toEqual(["b"])
    // and when listing runs filtered by multiple statuses
    // and then all matching runs are returned
    expect(
        sql
            .listRuns(clankhouse.db, { statuses: ["failed", "interrupted"] })
            .map((r) => r.id)
            .sort()
    ).toEqual(["b", "c"])
})

test("listRuns limits to last N", () => {
    // given three runs with increasing started_at times
    const { clankhouse } = tempClankHouse()
    sql.insertRun(clankhouse.db, runRow({ id: "a", started_at: "2026-01-01T00:00:00.000Z" }))
    sql.insertRun(clankhouse.db, runRow({ id: "b", started_at: "2026-01-02T00:00:00.000Z" }))
    sql.insertRun(clankhouse.db, runRow({ id: "c", started_at: "2026-01-03T00:00:00.000Z" }))

    // when listing runs with lastN of 2
    // then only the two most recent runs are returned
    expect(sql.listRuns(clankhouse.db, { lastN: 2 }).map((r) => r.id)).toEqual(["c", "b"])
})

test("listRuns combines all filters", () => {
    // given runs with a mix of matching and non-matching keys, workflow names, statuses, and attempts
    const { clankhouse } = tempClankHouse()
    sql.insertRun(
        clankhouse.db,
        runRow({
            id: "a",
            key: "k",
            workflow_name: "wf1",
            status: "succeeded",
            started_at: "2026-01-01T00:00:00.000Z"
        })
    )
    sql.insertRun(
        clankhouse.db,
        runRow({
            id: "b",
            key: "k",
            attempt: 2,
            workflow_name: "wf1",
            status: "succeeded",
            started_at: "2026-01-02T00:00:00.000Z"
        })
    )
    sql.insertRun(
        clankhouse.db,
        runRow({
            id: "c",
            key: "k",
            attempt: 3,
            workflow_name: "wf1",
            status: "failed",
            started_at: "2026-01-03T00:00:00.000Z"
        })
    )
    sql.insertRun(clankhouse.db, runRow({ id: "d", key: "other", workflow_name: "wf1", status: "succeeded" }))
    sql.insertRun(clankhouse.db, runRow({ id: "e", key: "k", workflow_name: "wf2", status: "succeeded" }))

    // when listing runs with key, workflow name, status, and lastN filters combined
    const rows = sql.listRuns(clankhouse.db, {
        key: "k",
        workflowName: "wf1",
        statuses: ["succeeded"],
        lastN: 1
    })

    // then only the single run matching all filters is returned
    expect(rows.map((r) => r.id)).toEqual(["b"])
})

test("resetStep clears output, error, timestamps, and execution metadata", () => {
    // given a succeeded step carrying output, disabled snapshots, and each linkage column
    const { clankhouse } = tempClankHouse()
    sql.insertRun(clankhouse.db, runRow({ id: "r" }))
    sql.insertSession(clankhouse.db, {
        id: "sess-1",
        kind: "coding-agent",
        client: "fake-agent",
        provider: "fake",
        model: "fake",
        started_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertArtifact(clankhouse.db, {
        id: "art-1",
        run_id: "r",
        name: "report",
        file: "artifacts/r/report",
        kind: "text",
        mime_type: null,
        created_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertStep(clankhouse.db, {
        id: "s",
        run_id: "r",
        key: "k",
        name: "k",
        seq: 0,
        kind: "agent",
        started_at: "2026-01-01T00:00:00.000Z"
    })
    sql.setStepColumn(clankhouse.db, "s", "session_id", "sess-1")
    sql.setStepColumn(clankhouse.db, "s", "snapshot_ref", "refs/clankhouse/x")
    sql.setStepColumn(clankhouse.db, "s", "snapshot_enabled", 0)
    sql.setStepColumn(clankhouse.db, "s", "artifact_id", "art-1")
    sql.setStepColumn(clankhouse.db, "s", "event_key", "evt-1")
    sql.succeedStep(clankhouse.db, "s", "42", "2026-01-02T00:00:00.000Z")
    sql.failStep(clankhouse.db, "s", "Duplicate step", "workflow_step_duplicate", "2026-01-02T00:00:00.000Z")

    // when the step is reset for re-execution
    sql.resetStep(clankhouse.db, "s", "2026-01-03T00:00:00.000Z")

    // then it returns to interrupted with output, error, and end time cleared and the start time refreshed
    const step = sql.findStep(clankhouse.db, "r", "k")!
    expect(step.status).toBe("interrupted")
    expect(step.output).toBeNull()
    expect(step.error).toBeNull()
    expect(step.error_code).toBeNull()
    expect(step.ended_at).toBeNull()
    expect(step.started_at).toBe("2026-01-03T00:00:00.000Z")
    // and no linkage from the previous attempt lingers
    expect(step.session_id).toBeNull()
    expect(step.snapshot_ref).toBeNull()
    expect(step.snapshot_enabled).toBe(1)
    expect(step.artifact_id).toBeNull()
    expect(step.event_key).toBeNull()
})

test("copyStep preserves the coding agent snapshot mode", () => {
    // given a succeeded snapshotless agent step and a destination run
    const { clankhouse } = tempClankHouse()
    sql.insertRun(clankhouse.db, runRow({ id: "source" }))
    sql.insertRun(clankhouse.db, runRow({ id: "destination" }))
    sql.insertStep(clankhouse.db, {
        id: "source-step",
        run_id: "source",
        key: "review",
        name: "review",
        seq: 0,
        kind: "agent",
        started_at: "2026-01-01T00:00:00.000Z"
    })
    sql.setStepColumn(clankhouse.db, "source-step", "snapshot_enabled", 0)
    sql.succeedStep(clankhouse.db, "source-step", JSON.stringify({ done: true }), "2026-01-02T00:00:00.000Z")
    const source = sql.findStep(clankhouse.db, "source", "review")!

    // when the step is copied into the destination run
    sql.copyStep(clankhouse.db, { ...source, id: "destination-step", run_id: "destination" })

    // then the copied step remains snapshotless
    expect(sql.findStep(clankhouse.db, "destination", "review")!.snapshot_enabled).toBe(0)
})

test("copyStep preserves a failed step's error code", () => {
    // given a coded failed step and a destination run
    const { clankhouse } = tempClankHouse()
    sql.insertRun(clankhouse.db, runRow({ id: "source" }))
    sql.insertRun(clankhouse.db, runRow({ id: "destination" }))
    sql.insertStep(clankhouse.db, {
        id: "source-step",
        run_id: "source",
        key: "coded",
        name: "coded",
        seq: 0,
        kind: "custom",
        started_at: "2026-01-01T00:00:00.000Z"
    })
    sql.failStep(clankhouse.db, "source-step", "invalid output", "ai_output_invalid", "2026-01-02T00:00:00.000Z")
    const source = sql.findStep(clankhouse.db, "source", "coded")!

    // when the step row is copied to the destination run
    sql.copyStep(clankhouse.db, { ...source, id: "destination-step", run_id: "destination" })

    // then its message and stable code are both retained
    expect(sql.findStep(clankhouse.db, "destination", "coded")).toMatchObject({
        error: "invalid output",
        error_code: "ai_output_invalid"
    })
})

test("findDeliverableEvent matches any of the given keys and picks the oldest", () => {
    // given events with one non-matching key and two matching keys emitted at different times
    const { clankhouse } = tempClankHouse()
    sql.insertEvent(clankhouse.db, {
        id: "e1",
        key: "other",
        payload: "1",
        origin: null,
        emitted_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertEvent(clankhouse.db, {
        id: "e2",
        key: "b",
        payload: "2",
        origin: null,
        emitted_at: "2026-01-03T00:00:00.000Z"
    })
    sql.insertEvent(clankhouse.db, {
        id: "e3",
        key: "a",
        payload: "3",
        origin: null,
        emitted_at: "2026-01-02T00:00:00.000Z"
    })

    // when finding a deliverable event for keys "a" and "b"
    // then the oldest matching event is returned
    expect(sql.findDeliverableEvent(clankhouse.db, ["a", "b"], "s1")?.id).toBe("e3")
})

test("findDeliverableEvent skips consumed events and breaks ties by id", () => {
    // given two events with the same key and emitted_at, the first already consumed by another consumer
    const { clankhouse } = tempClankHouse()
    sql.insertEvent(clankhouse.db, {
        id: "e1",
        key: "a",
        payload: "1",
        origin: null,
        emitted_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertEvent(clankhouse.db, {
        id: "e2",
        key: "a",
        payload: "2",
        origin: null,
        emitted_at: "2026-01-01T00:00:00.000Z"
    })
    sql.consumeEvent(clankhouse.db, "e1", "2026-01-05T00:00:00.000Z", "s1")

    // when finding a deliverable event for key "a" as a different consumer
    // then the unconsumed event is returned, breaking the emitted_at tie by id
    expect(sql.findDeliverableEvent(clankhouse.db, ["a"], "s2")?.id).toBe("e2")

    // and when the remaining event is also consumed
    sql.consumeEvent(clankhouse.db, "e2", "2026-01-05T00:00:00.000Z", "s2")

    // and then no deliverable event remains for a new consumer
    expect(sql.findDeliverableEvent(clankhouse.db, ["a"], "s3")).toBeUndefined()
})

test("findDeliverableEvent prefers the event already consumed by the same consumer", () => {
    // given two events with the same key, the newer one already consumed by consumer "s1"
    const { clankhouse } = tempClankHouse()
    sql.insertEvent(clankhouse.db, {
        id: "e1",
        key: "a",
        payload: "1",
        origin: null,
        emitted_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertEvent(clankhouse.db, {
        id: "e2",
        key: "a",
        payload: "2",
        origin: null,
        emitted_at: "2026-01-02T00:00:00.000Z"
    })
    sql.consumeEvent(clankhouse.db, "e2", "2026-01-05T00:00:00.000Z", "s1")

    // when finding a deliverable event for key "a" as the same consumer "s1"
    // then the event it already consumed is returned instead of the older unconsumed one
    expect(sql.findDeliverableEvent(clankhouse.db, ["a"], "s1")?.id).toBe("e2")
})
