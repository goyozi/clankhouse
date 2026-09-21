---
"@clankhouse/core": patch
---

Add configurable initial snapshot handling to file creation event sources

Model API and active event sources explicitly, restrict triggers to active sources, and expose optional checks on event source handles. File source handles provide `check()` to await a fresh observation.
