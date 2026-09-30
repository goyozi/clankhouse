---
"@clankhouse/cli": patch
---

Add `clank ps` to list running workflow runs

`clank ps` accepts the same options as `clank runs list` except `--status`. Both commands now list at most 20 runs unless `--limit` is given.
