# @clankhouse/core

## 0.0.3

### Patch Changes

- bc86e04: Add configurable initial snapshot handling to file creation event sources

    Model API and active event sources explicitly, restrict triggers to active sources, and expose optional checks on event source handles. File source handles provide `check()` to await a fresh observation.

- 29b42fc: Implement workflow trigger support

## 0.0.2

### Patch Changes

- 35dd504: Add automated npm releases with fixed package versions.
  Extract the shared Protocol Buffers contract into `@clankhouse/protocol` so clients no longer depend on the server package.
