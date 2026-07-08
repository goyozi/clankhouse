import { expect, test } from "vitest"
import * as sql from "@loopy/core/db"
import type { RunRow } from "@loopy/core/db"
import { tempLoopy } from "@loopy/test-utils"

function runRow(overrides: Partial<RunRow> & Pick<RunRow, "id">): RunRow {
    return {
        key: overrides.id,
        attempt: 1,
        workflow_name: "wf",
        input: null,
        output: null,
        error: null,
        status: "succeeded",
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: null,
        ...overrides
    }
}

test("listRuns without filter returns all runs ordered by started_at desc, attempt desc", () => {
    // given four runs with varying started_at times and one repeated key with a higher attempt
    const { loopy } = tempLoopy()
    sql.insertRun(loopy.db, runRow({ id: "a", started_at: "2026-01-01T00:00:00.000Z" }))
    sql.insertRun(loopy.db, runRow({ id: "b", started_at: "2026-01-03T00:00:00.000Z" }))
    sql.insertRun(loopy.db, runRow({ id: "c", key: "b", attempt: 2, started_at: "2026-01-03T00:00:00.000Z" }))
    sql.insertRun(loopy.db, runRow({ id: "d", started_at: "2026-01-02T00:00:00.000Z" }))

    // when listing runs with no filter
    // then runs are ordered by started_at desc, then attempt desc
    expect(sql.listRuns(loopy.db, {}).map((r) => r.id)).toEqual(["c", "b", "d", "a"])
})

test("listRuns filters by key", () => {
    // given two runs with different keys
    const { loopy } = tempLoopy()
    sql.insertRun(loopy.db, runRow({ id: "a", key: "k1" }))
    sql.insertRun(loopy.db, runRow({ id: "b", key: "k2" }))

    // when listing runs filtered by key "k1"
    // then only the matching run is returned
    expect(sql.listRuns(loopy.db, { key: "k1" }).map((r) => r.id)).toEqual(["a"])
})

test("listRuns filters by workflow name", () => {
    // given two runs with different workflow names
    const { loopy } = tempLoopy()
    sql.insertRun(loopy.db, runRow({ id: "a", workflow_name: "wf1" }))
    sql.insertRun(loopy.db, runRow({ id: "b", workflow_name: "wf2" }))

    // when listing runs filtered by workflow name "wf2"
    // then only the matching run is returned
    expect(sql.listRuns(loopy.db, { workflowName: "wf2" }).map((r) => r.id)).toEqual(["b"])
})

test("listRuns filters by one or many statuses", () => {
    // given three runs with different statuses
    const { loopy } = tempLoopy()
    sql.insertRun(loopy.db, runRow({ id: "a", status: "succeeded" }))
    sql.insertRun(loopy.db, runRow({ id: "b", status: "failed" }))
    sql.insertRun(loopy.db, runRow({ id: "c", status: "interrupted" }))

    // when listing runs filtered by a single status
    // then only the matching run is returned
    expect(sql.listRuns(loopy.db, { statuses: ["failed"] }).map((r) => r.id)).toEqual(["b"])
    // and when listing runs filtered by multiple statuses
    // and then all matching runs are returned
    expect(
        sql
            .listRuns(loopy.db, { statuses: ["failed", "interrupted"] })
            .map((r) => r.id)
            .sort()
    ).toEqual(["b", "c"])
})

test("listRuns limits to last N", () => {
    // given three runs with increasing started_at times
    const { loopy } = tempLoopy()
    sql.insertRun(loopy.db, runRow({ id: "a", started_at: "2026-01-01T00:00:00.000Z" }))
    sql.insertRun(loopy.db, runRow({ id: "b", started_at: "2026-01-02T00:00:00.000Z" }))
    sql.insertRun(loopy.db, runRow({ id: "c", started_at: "2026-01-03T00:00:00.000Z" }))

    // when listing runs with lastN of 2
    // then only the two most recent runs are returned
    expect(sql.listRuns(loopy.db, { lastN: 2 }).map((r) => r.id)).toEqual(["c", "b"])
})

test("listRuns combines all filters", () => {
    // given runs with a mix of matching and non-matching keys, workflow names, statuses, and attempts
    const { loopy } = tempLoopy()
    sql.insertRun(
        loopy.db,
        runRow({
            id: "a",
            key: "k",
            workflow_name: "wf1",
            status: "succeeded",
            started_at: "2026-01-01T00:00:00.000Z"
        })
    )
    sql.insertRun(
        loopy.db,
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
        loopy.db,
        runRow({
            id: "c",
            key: "k",
            attempt: 3,
            workflow_name: "wf1",
            status: "failed",
            started_at: "2026-01-03T00:00:00.000Z"
        })
    )
    sql.insertRun(loopy.db, runRow({ id: "d", key: "other", workflow_name: "wf1", status: "succeeded" }))
    sql.insertRun(loopy.db, runRow({ id: "e", key: "k", workflow_name: "wf2", status: "succeeded" }))

    // when listing runs with key, workflow name, status, and lastN filters combined
    const rows = sql.listRuns(loopy.db, {
        key: "k",
        workflowName: "wf1",
        statuses: ["succeeded"],
        lastN: 1
    })

    // then only the single run matching all filters is returned
    expect(rows.map((r) => r.id)).toEqual(["b"])
})

test("resetStep clears output, error, timestamps, and every linkage column", () => {
    // given a succeeded step carrying output and each of its linkage columns, with real session and artifact rows behind the foreign keys
    const { loopy } = tempLoopy()
    sql.insertRun(loopy.db, runRow({ id: "r" }))
    sql.insertSession(loopy.db, {
        id: "sess-1",
        kind: "coding-agent",
        provider: "fake",
        model: "fake",
        started_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertArtifact(loopy.db, {
        id: "art-1",
        run_id: "r",
        name: "report",
        file: "artifacts/r/report",
        kind: "text",
        mime_type: null,
        created_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertStep(loopy.db, {
        id: "s",
        run_id: "r",
        key: "k",
        name: "k",
        seq: 0,
        kind: "agent",
        started_at: "2026-01-01T00:00:00.000Z"
    })
    sql.setStepColumn(loopy.db, "s", "session_id", "sess-1")
    sql.setStepColumn(loopy.db, "s", "snapshot_ref", "refs/loopy/x")
    sql.setStepColumn(loopy.db, "s", "artifact_id", "art-1")
    sql.setStepColumn(loopy.db, "s", "event_key", "evt-1")
    sql.succeedStep(loopy.db, "s", "42", "2026-01-02T00:00:00.000Z")

    // when the step is reset for re-execution
    sql.resetStep(loopy.db, "s", "2026-01-03T00:00:00.000Z")

    // then it returns to interrupted with output, error, and end time cleared and the start time refreshed
    const step = sql.findStep(loopy.db, "r", "k")!
    expect(step.status).toBe("interrupted")
    expect(step.output).toBeNull()
    expect(step.error).toBeNull()
    expect(step.ended_at).toBeNull()
    expect(step.started_at).toBe("2026-01-03T00:00:00.000Z")
    // and no linkage from the previous attempt lingers
    expect(step.session_id).toBeNull()
    expect(step.snapshot_ref).toBeNull()
    expect(step.artifact_id).toBeNull()
    expect(step.event_key).toBeNull()
})

test("findDeliverableEvent matches any of the given keys and picks the oldest", () => {
    // given events with one non-matching key and two matching keys emitted at different times
    const { loopy } = tempLoopy()
    sql.insertEvent(loopy.db, {
        id: "e1",
        key: "other",
        payload: "1",
        origin: null,
        emitted_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertEvent(loopy.db, {
        id: "e2",
        key: "b",
        payload: "2",
        origin: null,
        emitted_at: "2026-01-03T00:00:00.000Z"
    })
    sql.insertEvent(loopy.db, {
        id: "e3",
        key: "a",
        payload: "3",
        origin: null,
        emitted_at: "2026-01-02T00:00:00.000Z"
    })

    // when finding a deliverable event for keys "a" and "b"
    // then the oldest matching event is returned
    expect(sql.findDeliverableEvent(loopy.db, ["a", "b"], "s1")?.id).toBe("e3")
})

test("findDeliverableEvent skips consumed events and breaks ties by id", () => {
    // given two events with the same key and emitted_at, the first already consumed by another consumer
    const { loopy } = tempLoopy()
    sql.insertEvent(loopy.db, {
        id: "e1",
        key: "a",
        payload: "1",
        origin: null,
        emitted_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertEvent(loopy.db, {
        id: "e2",
        key: "a",
        payload: "2",
        origin: null,
        emitted_at: "2026-01-01T00:00:00.000Z"
    })
    sql.consumeEvent(loopy.db, "e1", "2026-01-05T00:00:00.000Z", "s1")

    // when finding a deliverable event for key "a" as a different consumer
    // then the unconsumed event is returned, breaking the emitted_at tie by id
    expect(sql.findDeliverableEvent(loopy.db, ["a"], "s2")?.id).toBe("e2")

    // and when the remaining event is also consumed
    sql.consumeEvent(loopy.db, "e2", "2026-01-05T00:00:00.000Z", "s2")

    // and then no deliverable event remains for a new consumer
    expect(sql.findDeliverableEvent(loopy.db, ["a"], "s3")).toBeUndefined()
})

test("findDeliverableEvent prefers the event already consumed by the same consumer", () => {
    // given two events with the same key, the newer one already consumed by consumer "s1"
    const { loopy } = tempLoopy()
    sql.insertEvent(loopy.db, {
        id: "e1",
        key: "a",
        payload: "1",
        origin: null,
        emitted_at: "2026-01-01T00:00:00.000Z"
    })
    sql.insertEvent(loopy.db, {
        id: "e2",
        key: "a",
        payload: "2",
        origin: null,
        emitted_at: "2026-01-02T00:00:00.000Z"
    })
    sql.consumeEvent(loopy.db, "e2", "2026-01-05T00:00:00.000Z", "s1")

    // when finding a deliverable event for key "a" as the same consumer "s1"
    // then the event it already consumed is returned instead of the older unconsumed one
    expect(sql.findDeliverableEvent(loopy.db, ["a"], "s1")?.id).toBe("e2")
})
