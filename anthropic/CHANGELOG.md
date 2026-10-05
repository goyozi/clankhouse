# @clankhouse/anthropic

## 0.1.0

### Minor Changes

- 6a91bd5: Release 0.1
- 12ea6c5: Make provider SDKs peer dependencies

    `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@earendil-works/pi-coding-agent` and `@anthropic-ai/sdk` are now peer dependencies with wide ranges, so you can upgrade them to pick up new models without waiting for a ClankHouse release. Install the SDK next to its adapter, e.g. `pnpm add @clankhouse/codex @openai/codex-sdk`, and run `pnpm update --latest <sdk>` to upgrade it.

### Patch Changes

- Updated dependencies [6a91bd5]
- Updated dependencies [3f265a5]
- Updated dependencies [bc86e04]
- Updated dependencies [9c986f3]
- Updated dependencies [29b42fc]
- Updated dependencies [e0277ca]
- Updated dependencies [ceb167d]
- Updated dependencies [f3fa9c9]
- Updated dependencies [7fa999d]
    - @clankhouse/core@0.1.0

## 0.0.2

### Patch Changes

- 35dd504: Add automated npm releases with fixed package versions.
  Extract the shared Protocol Buffers contract into `@clankhouse/protocol` so clients no longer depend on the server package.
- Updated dependencies [35dd504]
    - @clankhouse/core@0.0.2
