---
"@clankhouse/core": patch
"@clankhouse/server": patch
---

Soft delete old succeeded and failed runs during `gc`

`gc` accepts `minAgeDays` (default 14) and `deleteRuns` (default true). Deleted runs keep a hidden tombstone, sessions are owned by runs, and reruns copy reused sessions.
