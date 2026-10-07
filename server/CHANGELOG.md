# @clankhouse/server

## 0.2.0

### Patch Changes

- 3560251: Add usage examples to package READMEs
- Updated dependencies [3560251]
- Updated dependencies [7c2ced0]
    - @clankhouse/core@0.2.0
    - @clankhouse/protocol@0.2.0

## 0.1.0

### Minor Changes

- 6a91bd5: Release 0.1
- 7fa999d: `serve` now runs GC in the background after startup and then every 24 hours. Pass `gc: false` to disable it or `GcOptions` to customize it; invalid options fail `serve` before it binds.

### Patch Changes

- 9c986f3: Add run cancellation

    `cancel(runId)` marks an active or interrupted run `canceled`, a new final run status. An active run stops at its next step boundary: a step that settles after cancellation stays `interrupted` and its result is discarded. Custom steps receive the run's abort signal as `step(name, schema, ({ signal }) => ...)`, and event waits are released on cancel. `start` returns canceled runs as a no-op, inline `run()` throws `workflow_run_canceled`, `resume` rejects them, `rerun` accepts them and GC collects them. `ExecutionStatus` gains `CANCELED`, which the CLI renders as `canceled`.

- 9d88c78: Recover interrupted runs when starting a server with `serve`

    `serve` calls `recover()` once after binding, unless `recover: false` is passed. Runs that fail to resume are reported to `onError`, and the result is exposed on the returned handle as `recovered`. Workflows must be registered before `serve` is called. `listen` never recovers.

- e0277ca: Make `start` an idempotent create that never resumes runs

    `start` returns `{ runId, status }`. If a run already exists for the key, in any status, it is returned without being dispatched: interrupted runs are no longer resumed (use `resume` or `recover`) and failed runs no longer throw `workflow_run_failed`. `StartRunResponse` includes the run `status`, and `clank runs start` / `clank run` print a notice to stderr when the run already exists.

- 6aa0f8a: Add `CancelRun` RPC and `clank runs cancel <run-id>`

    The server's `CancelRun` cancels an active or interrupted run through `cancel(runId)`, succeeds for an already canceled run, and reports other final runs as `FailedPrecondition` and missing or deleted runs as `NotFound`. `clank runs cancel <run-id>` returns without waiting for the run to stop and prints `Run <run-id> canceled`, or the empty `CancelRunResponse` with `--json`.

- f3fa9c9: Soft delete old succeeded and failed runs during `gc`

    `gc` accepts `minAgeDays` (default 14) and `deleteRuns` (default true). Deleted runs keep a hidden tombstone, sessions are owned by runs, and reruns copy reused sessions.

- Updated dependencies [6a91bd5]
- Updated dependencies [3f265a5]
- Updated dependencies [bc86e04]
- Updated dependencies [9c986f3]
- Updated dependencies [29b42fc]
- Updated dependencies [e0277ca]
- Updated dependencies [6aa0f8a]
- Updated dependencies [ceb167d]
- Updated dependencies [f3fa9c9]
- Updated dependencies [7fa999d]
    - @clankhouse/core@0.1.0
    - @clankhouse/protocol@0.1.0

## 0.0.2

### Patch Changes

- 35dd504: Add automated npm releases with fixed package versions.
  Extract the shared Protocol Buffers contract into `@clankhouse/protocol` so clients no longer depend on the server package.
- Updated dependencies [35dd504]
    - @clankhouse/core@0.0.2
    - @clankhouse/protocol@0.0.2
