---
"@clankhouse/core": patch
"@clankhouse/protocol": patch
"@clankhouse/server": patch
"clankhouse": patch
---

Make `start` an idempotent create that never resumes runs

`start` returns `{ runId, status }`. If a run already exists for the key, in any status, it is returned without being dispatched: interrupted runs are no longer resumed (use `resume` or `recover`) and failed runs no longer throw `workflow_run_failed`. `StartRunResponse` includes the run `status`, and `clank runs start` / `clank run` print a notice to stderr when the run already exists.
