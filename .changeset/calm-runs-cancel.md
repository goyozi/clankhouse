---
"@clankhouse/core": patch
"@clankhouse/protocol": patch
"@clankhouse/server": patch
"clankhouse": patch
---

Add run cancellation

`cancel(runId)` marks an active or interrupted run `canceled`, a new final run status. An active run stops at its next step boundary: a step that settles after cancellation stays `interrupted` and its result is discarded. Custom steps receive the run's abort signal as `step(name, schema, ({ signal }) => ...)`, and event waits are released on cancel. `start` returns canceled runs as a no-op, inline `run()` throws `workflow_run_canceled`, `resume` rejects them, `rerun` accepts them and GC collects them. `ExecutionStatus` gains `CANCELED`, which the CLI renders as `canceled`.
