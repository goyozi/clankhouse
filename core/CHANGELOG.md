# @clankhouse/core

## 0.1.0

### Minor Changes

- 6a91bd5: Release 0.1

### Patch Changes

- 3f265a5: Add `recover()` for interrupted runs

    Workflows accept a `recovery` option (`"resume"` by default, or `"manual"`). `recover()` resumes interrupted runs of workflows with the `resume` policy, oldest first, and reports resumed, skipped and failed runs.

- bc86e04: Add configurable initial snapshot handling to file creation event sources

    Model API and active event sources explicitly, restrict triggers to active sources, and expose optional checks on event source handles. File source handles provide `check()` to await a fresh observation.

- 9c986f3: Add run cancellation

    `cancel(runId)` marks an active or interrupted run `canceled`, a new final run status. An active run stops at its next step boundary: a step that settles after cancellation stays `interrupted` and its result is discarded. Custom steps receive the run's abort signal as `step(name, schema, ({ signal }) => ...)`, and event waits are released on cancel. `start` returns canceled runs as a no-op, inline `run()` throws `workflow_run_canceled`, `resume` rejects them, `rerun` accepts them and GC collects them. `ExecutionStatus` gains `CANCELED`, which the CLI renders as `canceled`.

- 29b42fc: Implement workflow trigger support
- e0277ca: Make `start` an idempotent create that never resumes runs

    `start` returns `{ runId, status }`. If a run already exists for the key, in any status, it is returned without being dispatched: interrupted runs are no longer resumed (use `resume` or `recover`) and failed runs no longer throw `workflow_run_failed`. `StartRunResponse` includes the run `status`, and `clank runs start` / `clank run` print a notice to stderr when the run already exists.

- ceb167d: Add a durable `moveFile` step that creates missing parent directories, refuses to overwrite an existing destination, and succeeds without changes when the file has already been moved
- f3fa9c9: Soft delete old succeeded and failed runs during `gc`

    `gc` accepts `minAgeDays` (default 14) and `deleteRuns` (default true). Deleted runs keep a hidden tombstone, sessions are owned by runs, and reruns copy reused sessions.

- 7fa999d: `serve` now runs GC in the background after startup and then every 24 hours. Pass `gc: false` to disable it or `GcOptions` to customize it; invalid options fail `serve` before it binds.

## 0.0.2

### Patch Changes

- 35dd504: Add automated npm releases with fixed package versions.
  Extract the shared Protocol Buffers contract into `@clankhouse/protocol` so clients no longer depend on the server package.
