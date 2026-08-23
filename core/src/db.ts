import Database from "better-sqlite3"
import type { ClankHouseErrorCode } from "./errors"

export type Db = Database.Database
type Statement = Database.Statement

/*
 * ============================================================================
 * Shared database plumbing
 * ============================================================================
 */

export type PersistedStatus = "interrupted" | "succeeded" | "failed"

type Statements = {
    runs: RunStatements
    steps: StepStatements
    artifacts: ArtifactStatements
    sessions: SessionStatements
    events: EventStatements
}

const statementCache = new WeakMap<Db, Statements>()

export function openDatabase(file: string): Db {
    const db = new Database(file)
    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")
    db.exec(schemaDDL())
    return db
}

function schemaDDL(): string {
    return [RUNS_DDL, STEPS_DDL, ARTIFACTS_DDL, SESSIONS_DDL, EVENTS_DDL].join("\n")
}

function statements(db: Db): Statements {
    let stmts = statementCache.get(db)
    if (!stmts) {
        stmts = prepareStatements(db)
        statementCache.set(db, stmts)
    }
    return stmts
}

function prepareStatements(db: Db): Statements {
    return {
        runs: prepareRunStatements(db),
        steps: prepareStepStatements(db),
        artifacts: prepareArtifactStatements(db),
        sessions: prepareSessionStatements(db),
        events: prepareEventStatements(db)
    }
}

/*
 * ============================================================================
 * Runs
 * ============================================================================
 */

const RUNS_DDL = `
CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    key           TEXT NOT NULL,
    attempt       INTEGER NOT NULL,
    workflow_name TEXT NOT NULL,
    input         TEXT,
    output        TEXT,
    error         TEXT,
    error_code    TEXT,
    status        TEXT NOT NULL CHECK (status IN ('interrupted','succeeded','failed')),
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    UNIQUE (workflow_name, key, attempt)
);
CREATE INDEX IF NOT EXISTS idx_runs_key ON runs(key);
CREATE INDEX IF NOT EXISTS idx_runs_workflow_name ON runs(workflow_name);
`

export type RunRow = {
    id: string
    key: string
    attempt: number
    workflow_name: string
    input: string | null
    output: string | null
    error: string | null
    error_code: ClankHouseErrorCode | null
    status: PersistedStatus
    started_at: string
    ended_at: string | null
}

export type ListRunsFilter = {
    key?: string
    workflowName?: string
    statuses?: PersistedStatus[]
    lastN?: number
}

type RunStatements = {
    insert: Statement
    findLastAttempt: Statement
    findById: Statement
    succeed: Statement
    fail: Statement
}

function prepareRunStatements(db: Db): RunStatements {
    return {
        insert: db.prepare(
            "INSERT INTO runs (id, key, attempt, workflow_name, input, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ),
        findLastAttempt: db.prepare(
            "SELECT * FROM runs WHERE workflow_name = ? AND key = ? ORDER BY attempt DESC LIMIT 1"
        ),
        findById: db.prepare("SELECT * FROM runs WHERE id = ?"),
        succeed: db.prepare("UPDATE runs SET status = 'succeeded', output = ?, ended_at = ? WHERE id = ?"),
        fail: db.prepare("UPDATE runs SET status = 'failed', error = ?, error_code = ?, ended_at = ? WHERE id = ?")
    }
}

export function insertRun(db: Db, row: RunRow): void {
    statements(db).runs.insert.run(
        row.id,
        row.key,
        row.attempt,
        row.workflow_name,
        row.input,
        row.status,
        row.started_at
    )
}

export function findLastAttempt(db: Db, workflowName: string, key: string): RunRow | undefined {
    return statements(db).runs.findLastAttempt.get(workflowName, key) as RunRow | undefined
}

export function findRunById(db: Db, id: string): RunRow | undefined {
    return statements(db).runs.findById.get(id) as RunRow | undefined
}

export function succeedRun(db: Db, id: string, output: string | null, endedAt: string): void {
    statements(db).runs.succeed.run(output, endedAt, id)
}

export function failRun(
    db: Db,
    id: string,
    error: string,
    errorCode: ClankHouseErrorCode | null,
    endedAt: string
): void {
    statements(db).runs.fail.run(error, errorCode, endedAt, id)
}

export function listRuns(db: Db, filter: ListRunsFilter): RunRow[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter.key !== undefined) {
        clauses.push("key = ?")
        params.push(filter.key)
    }
    if (filter.workflowName !== undefined) {
        clauses.push("workflow_name = ?")
        params.push(filter.workflowName)
    }
    if (filter.statuses !== undefined) {
        clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`)
        params.push(...filter.statuses)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    let limit = ""
    if (filter.lastN !== undefined) {
        limit = " LIMIT ?"
        params.push(filter.lastN)
    }
    return db
        .prepare(`SELECT * FROM runs${where} ORDER BY started_at DESC, attempt DESC${limit}`)
        .all(...params) as unknown as RunRow[]
}

/*
 * ============================================================================
 * Steps
 * ============================================================================
 */

const STEPS_DDL = `
CREATE TABLE IF NOT EXISTS steps (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id),
    key          TEXT NOT NULL,
    name         TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('custom','artifact','llm','agent','event','worktree')),
    status       TEXT NOT NULL CHECK (status IN ('interrupted','succeeded','failed')),
    output       TEXT,
    error        TEXT,
    error_code   TEXT,
    session_id   TEXT REFERENCES sessions(id),
    snapshot_ref TEXT,
    snapshot_enabled INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_enabled IN (0, 1)),
    artifact_id  TEXT REFERENCES artifacts(id),
    event_key    TEXT,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    UNIQUE (run_id, key)
);
CREATE INDEX IF NOT EXISTS idx_steps_run_id_seq ON steps(run_id, seq);
`

export type StepKind = "custom" | "artifact" | "llm" | "agent" | "event" | "worktree"

export type StepColumn = "session_id" | "snapshot_ref" | "snapshot_enabled" | "artifact_id" | "event_key"

export type StepRow = {
    id: string
    run_id: string
    key: string
    name: string
    seq: number
    kind: StepKind
    status: PersistedStatus
    output: string | null
    error: string | null
    error_code: ClankHouseErrorCode | null
    session_id: string | null
    snapshot_ref: string | null
    snapshot_enabled: 0 | 1
    artifact_id: string | null
    event_key: string | null
    started_at: string
    ended_at: string | null
}

export type NewStepRow = Pick<StepRow, "id" | "run_id" | "key" | "name" | "seq" | "kind" | "started_at">

type StepStatements = {
    findById: Statement
    findByRunAndKey: Statement
    findByRun: Statement
    findBefore: Statement
    findFrom: Statement
    maxSeq: Statement
    insert: Statement
    copy: Statement
    reset: Statement
    succeed: Statement
    fail: Statement
    setColumn: Record<StepColumn, Statement>
}

function prepareStepStatements(db: Db): StepStatements {
    const setColumn = (column: StepColumn) => db.prepare(`UPDATE steps SET ${column} = ? WHERE id = ?`)
    return {
        findById: db.prepare("SELECT * FROM steps WHERE id = ?"),
        findByRunAndKey: db.prepare("SELECT * FROM steps WHERE run_id = ? AND key = ?"),
        findByRun: db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY seq"),
        findBefore: db.prepare("SELECT * FROM steps WHERE run_id = ? AND seq < ? ORDER BY seq"),
        findFrom: db.prepare("SELECT * FROM steps WHERE run_id = ? AND seq >= ? ORDER BY seq"),
        maxSeq: db.prepare("SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM steps WHERE run_id = ?"),
        insert: db.prepare(
            "INSERT INTO steps (id, run_id, key, name, seq, kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'interrupted', ?)"
        ),
        copy: db.prepare(`INSERT INTO steps (id, run_id, key, name, seq, kind, status, output, error, error_code, session_id, snapshot_ref, snapshot_enabled, artifact_id, event_key, started_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        reset: db.prepare(`UPDATE steps SET status = 'interrupted', output = NULL, error = NULL, error_code = NULL,
            session_id = NULL, snapshot_ref = NULL, snapshot_enabled = 1, artifact_id = NULL, event_key = NULL,
            started_at = ?, ended_at = NULL WHERE id = ?`),
        succeed: db.prepare("UPDATE steps SET status = 'succeeded', output = ?, ended_at = ? WHERE id = ?"),
        fail: db.prepare("UPDATE steps SET status = 'failed', error = ?, error_code = ?, ended_at = ? WHERE id = ?"),
        setColumn: {
            session_id: setColumn("session_id"),
            snapshot_ref: setColumn("snapshot_ref"),
            snapshot_enabled: setColumn("snapshot_enabled"),
            artifact_id: setColumn("artifact_id"),
            event_key: setColumn("event_key")
        }
    }
}

export function findStep(db: Db, runId: string, key: string): StepRow | undefined {
    return statements(db).steps.findByRunAndKey.get(runId, key) as StepRow | undefined
}

export function findStepById(db: Db, id: string): StepRow | undefined {
    return statements(db).steps.findById.get(id) as StepRow | undefined
}

export function findStepsFrom(db: Db, runId: string, seq: number): StepRow[] {
    return statements(db).steps.findFrom.all(runId, seq) as unknown as StepRow[]
}

export function findStepsByRun(db: Db, runId: string): StepRow[] {
    return statements(db).steps.findByRun.all(runId) as unknown as StepRow[]
}

export function findStepsBefore(db: Db, runId: string, seq: number): StepRow[] {
    return statements(db).steps.findBefore.all(runId, seq) as unknown as StepRow[]
}

export function findSucceededWorktreeSteps(db: Db): StepRow[] {
    return db
        .prepare("SELECT * FROM steps WHERE kind = 'worktree' AND status = 'succeeded' ORDER BY id")
        .all() as unknown as StepRow[]
}

export function findMaxStepSeq(db: Db, runId: string): number {
    const { maxSeq } = statements(db).steps.maxSeq.get(runId) as { maxSeq: number }
    return maxSeq
}

export function insertStep(db: Db, row: NewStepRow): void {
    statements(db).steps.insert.run(row.id, row.run_id, row.key, row.name, row.seq, row.kind, row.started_at)
}

export function copyStep(db: Db, row: StepRow): void {
    statements(db).steps.copy.run(
        row.id,
        row.run_id,
        row.key,
        row.name,
        row.seq,
        row.kind,
        row.status,
        row.output,
        row.error,
        row.error_code,
        row.session_id,
        row.snapshot_ref,
        row.snapshot_enabled,
        row.artifact_id,
        row.event_key,
        row.started_at,
        row.ended_at
    )
}

export function resetStep(db: Db, id: string, startedAt: string): void {
    statements(db).steps.reset.run(startedAt, id)
}

export function succeedStep(db: Db, id: string, output: string | null, endedAt: string): void {
    statements(db).steps.succeed.run(output, endedAt, id)
}

export function failStep(
    db: Db,
    id: string,
    error: string,
    errorCode: ClankHouseErrorCode | null,
    endedAt: string
): void {
    statements(db).steps.fail.run(error, errorCode, endedAt, id)
}

export function setStepColumn(db: Db, id: string, column: StepColumn, value: string | number): void {
    statements(db).steps.setColumn[column].run(value, id)
}

/*
 * ============================================================================
 * Artifacts
 * ============================================================================
 */

const ARTIFACTS_DDL = `
CREATE TABLE IF NOT EXISTS artifacts (
    id         TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL REFERENCES runs(id),
    name       TEXT NOT NULL,
    file       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('text','binary')),
    mime_type  TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
`

export type ArtifactRow = {
    id: string
    run_id: string
    name: string
    file: string
    kind: "text" | "binary"
    mime_type: string | null
    created_at: string
}

type ArtifactStatements = {
    insert: Statement
    findById: Statement
    findByRun: Statement
    deleteDuplicates: Statement
}

function prepareArtifactStatements(db: Db): ArtifactStatements {
    return {
        insert: db.prepare(
            "INSERT INTO artifacts (id, run_id, name, file, kind, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ),
        findById: db.prepare("SELECT * FROM artifacts WHERE id = ?"),
        findByRun: db.prepare("SELECT * FROM artifacts WHERE run_id = ?"),
        deleteDuplicates: db.prepare("DELETE FROM artifacts WHERE run_id = ? AND file = ? AND id != ?")
    }
}

export function insertArtifact(db: Db, row: ArtifactRow): void {
    statements(db).artifacts.insert.run(row.id, row.run_id, row.name, row.file, row.kind, row.mime_type, row.created_at)
}

export function findArtifactById(db: Db, id: string): ArtifactRow | undefined {
    return statements(db).artifacts.findById.get(id) as ArtifactRow | undefined
}

export function findArtifactsByRun(db: Db, runId: string): ArtifactRow[] {
    return statements(db).artifacts.findByRun.all(runId) as unknown as ArtifactRow[]
}

export function deleteDuplicateArtifacts(db: Db, runId: string, file: string, keepId: string): void {
    statements(db).artifacts.deleteDuplicates.run(runId, file, keepId)
}

/*
 * ============================================================================
 * Sessions
 * ============================================================================
 */

const SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('llm','coding-agent')),
    client     TEXT NOT NULL,
    provider   TEXT NOT NULL,
    model      TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('interrupted','succeeded','failed')),
    started_at TEXT NOT NULL,
    ended_at   TEXT
);

CREATE TABLE IF NOT EXISTS session_messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq        INTEGER NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('message','tool_call','tool_result')),
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, seq)
);
`

export type SessionRow = {
    id: string
    kind: "llm" | "coding-agent"
    client: string
    provider: string
    model: string
    status: PersistedStatus
    started_at: string
    ended_at: string | null
}

export type SessionMessageRow = {
    id: string
    session_id: string
    seq: number
    kind: "message" | "tool_call" | "tool_result"
    payload: string
    created_at: string
}

export type NewSessionRow = Pick<SessionRow, "id" | "kind" | "client" | "provider" | "model" | "started_at">

type SessionStatements = {
    insert: Statement
    findById: Statement
    succeed: Statement
    fail: Statement
    insertMessage: Statement
    findMessages: Statement
    findMessageById: Statement
}

function prepareSessionStatements(db: Db): SessionStatements {
    return {
        insert: db.prepare(
            "INSERT INTO sessions (id, kind, client, provider, model, status, started_at) VALUES (?, ?, ?, ?, ?, 'interrupted', ?)"
        ),
        findById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
        succeed: db.prepare("UPDATE sessions SET status = 'succeeded', ended_at = ? WHERE id = ?"),
        fail: db.prepare("UPDATE sessions SET status = 'failed', ended_at = ? WHERE id = ?"),
        insertMessage: db.prepare(
            "INSERT INTO session_messages (id, session_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ),
        findMessages: db.prepare("SELECT * FROM session_messages WHERE session_id = ? AND seq > ? ORDER BY seq"),
        findMessageById: db.prepare("SELECT * FROM session_messages WHERE id = ?")
    }
}

export function insertSession(db: Db, row: NewSessionRow): void {
    statements(db).sessions.insert.run(row.id, row.kind, row.client, row.provider, row.model, row.started_at)
}

export function findSessionById(db: Db, id: string): SessionRow | undefined {
    return statements(db).sessions.findById.get(id) as SessionRow | undefined
}

export function succeedSession(db: Db, id: string, endedAt: string): void {
    statements(db).sessions.succeed.run(endedAt, id)
}

export function failSession(db: Db, id: string, endedAt: string): void {
    statements(db).sessions.fail.run(endedAt, id)
}

export function insertSessionMessage(db: Db, row: SessionMessageRow): void {
    statements(db).sessions.insertMessage.run(row.id, row.session_id, row.seq, row.kind, row.payload, row.created_at)
}

export function findSessionMessages(db: Db, sessionId: string, afterSeq = -1): SessionMessageRow[] {
    return statements(db).sessions.findMessages.all(sessionId, afterSeq) as unknown as SessionMessageRow[]
}

export function findSessionMessageById(db: Db, id: string): SessionMessageRow | undefined {
    return statements(db).sessions.findMessageById.get(id) as SessionMessageRow | undefined
}

/*
 * ============================================================================
 * Events
 * ============================================================================
 */

const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL,
    payload     TEXT NOT NULL,
    origin      TEXT,
    emitted_at  TEXT NOT NULL,
    consumed_at TEXT,
    consumed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_key ON events(key);
CREATE INDEX IF NOT EXISTS idx_events_origin ON events(origin);
`

export type EventRow = {
    id: string
    key: string
    payload: string
    origin: string | null
    emitted_at: string
    consumed_at: string | null
    consumed_by: string | null
}

export type NewEventRow = Omit<EventRow, "consumed_at" | "consumed_by">

type EventStatements = {
    insert: Statement
    consume: Statement
    deleteUnconsumedByOrigin: Statement
}

function prepareEventStatements(db: Db): EventStatements {
    return {
        insert: db.prepare("INSERT INTO events (id, key, payload, origin, emitted_at) VALUES (?, ?, ?, ?, ?)"),
        consume: db.prepare("UPDATE events SET consumed_at = ?, consumed_by = ? WHERE id = ?"),
        deleteUnconsumedByOrigin: db.prepare("DELETE FROM events WHERE origin = ? AND consumed_at IS NULL")
    }
}

export function insertEvent(db: Db, row: NewEventRow): void {
    statements(db).events.insert.run(row.id, row.key, row.payload, row.origin, row.emitted_at)
}

export function deleteUnconsumedEventsByOrigin(db: Db, origin: string): void {
    statements(db).events.deleteUnconsumedByOrigin.run(origin)
}

export function findDeliverableEvent(db: Db, keys: string[], stepId: string): EventRow | undefined {
    const placeholders = keys.map(() => "?").join(", ")
    return db
        .prepare(
            `SELECT * FROM events WHERE key IN (${placeholders}) AND (consumed_at IS NULL OR consumed_by = ?) ORDER BY consumed_at IS NULL, emitted_at, id LIMIT 1`
        )
        .get(...keys, stepId) as EventRow | undefined
}

export function consumeEvent(db: Db, id: string, consumedAt: string, consumedBy: string): void {
    statements(db).events.consume.run(consumedAt, consumedBy, id)
}
