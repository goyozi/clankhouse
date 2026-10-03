---
"@clankhouse/server": minor
"@clankhouse/core": patch
---

`serve` now runs GC in the background after startup and then every 24 hours. Pass `gc: false` to disable it or `GcOptions` to customize it; invalid options fail `serve` before it binds.
