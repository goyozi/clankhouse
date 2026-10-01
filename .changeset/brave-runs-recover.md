---
"@clankhouse/core": patch
---

Add `recover()` for interrupted runs

Workflows accept a `recovery` option (`"resume"` by default, or `"manual"`). `recover()` resumes interrupted runs of workflows with the `resume` policy, oldest first, and reports resumed, skipped and failed runs.
