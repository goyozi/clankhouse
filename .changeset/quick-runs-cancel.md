---
"@clankhouse/protocol": patch
"@clankhouse/server": patch
"@clankhouse/cli": patch
---

Add `CancelRun` RPC and `clank runs cancel <run-id>`

The server's `CancelRun` cancels an active or interrupted run through `cancel(runId)`, succeeds for an already canceled run, and reports other final runs as `FailedPrecondition` and missing or deleted runs as `NotFound`. `clank runs cancel <run-id>` returns without waiting for the run to stop and prints `Run <run-id> canceled`, or the empty `CancelRunResponse` with `--json`.
