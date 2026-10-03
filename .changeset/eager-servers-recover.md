---
"@clankhouse/server": patch
---

Recover interrupted runs when starting a server with `serve`

`serve` calls `recover()` once after binding, unless `recover: false` is passed. Runs that fail to resume are reported to `onError`, and the result is exposed on the returned handle as `recovered`. Workflows must be registered before `serve` is called. `listen` never recovers.
