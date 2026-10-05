# @clankhouse/claude

## 0.1.0

### Minor Changes

- ffa5f27: Move agent SDK options under `sdkOptions`

    `ClaudeAgent`, `CodexAgent` and `PiAgent` now take `model` and `effort` (plus `provider` for Pi) at the top level, and every other SDK option under `sdkOptions`, typed as the SDK's own options minus the fields ClankHouse owns. Options that previously had no dedicated field, such as Claude's `mcpServers` or `hooks`, can now be passed through.

    - `ClaudeAgent`: `maxTurns`, `env`, `allowedTools`, `disallowedTools`, `settingSources` and `systemPrompt` move to `sdkOptions`.
    - `CodexAgent`: `modelReasoningEffort` becomes `effort`; client options (`codexPathOverride`, `baseUrl`, `apiKey`, `config`, `env`) move to `sdkOptions.client` and thread options (`sandboxMode`, `approvalPolicy`, `networkAccessEnabled`, `webSearchMode`, `additionalDirectories`) to `sdkOptions.thread`.
    - `PiAgent`: `sessionOptions` is renamed to `sdkOptions` and `thinkingLevel` becomes the top-level `effort`.

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
