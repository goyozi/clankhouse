# @clankhouse/protocol

## 0.1.0

### Minor Changes

- 6a91bd5: Release 0.1

### Patch Changes

- 9c986f3: Add run cancellation

    `cancel(runId)` marks an active or interrupted run `canceled`, a new final run status. An active run stops at its next step boundary: a step that settles after cancellation stays `interrupted` and its result is discarded. Custom steps receive the run's abort signal as `step(name, schema, ({ signal }) => ...)`, and event waits are released on cancel. `start` returns canceled runs as a no-op, inline `run()` throws `workflow_run_canceled`, `resume` rejects them, `rerun` accepts them and GC collects them. `ExecutionStatus` gains `CANCELED`, which the CLI renders as `canceled`.

- e0277ca: Make `start` an idempotent create that never resumes runs

    `start` returns `{ runId, status }`. If a run already exists for the key, in any status, it is returned without being dispatched: interrupted runs are no longer resumed (use `resume` or `recover`) and failed runs no longer throw `workflow_run_failed`. `StartRunResponse` includes the run `status`, and `clank runs start` / `clank run` print a notice to stderr when the run already exists.

- 6aa0f8a: Add `CancelRun` RPC and `clank runs cancel <run-id>`

    The server's `CancelRun` cancels an active or interrupted run through `cancel(runId)`, succeeds for an already canceled run, and reports other final runs as `FailedPrecondition` and missing or deleted runs as `NotFound`. `clank runs cancel <run-id>` returns without waiting for the run to stop and prints `Run <run-id> canceled`, or the empty `CancelRunResponse` with `--json`.

## 0.0.2
