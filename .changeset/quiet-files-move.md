---
"@clankhouse/core": patch
---

Add a durable `moveFile` step that creates missing parent directories, refuses to overwrite an existing destination, and succeeds without changes when the file has already been moved
