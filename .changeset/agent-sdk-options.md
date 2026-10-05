---
"@clankhouse/claude": minor
"@clankhouse/codex": minor
"@clankhouse/pi": minor
---

Move agent SDK options under `sdkOptions`

`ClaudeAgent`, `CodexAgent` and `PiAgent` now take `model` and `effort` (plus `provider` for Pi) at the top level, and every other SDK option under `sdkOptions`, typed as the SDK's own options minus the fields ClankHouse owns. Options that previously had no dedicated field, such as Claude's `mcpServers` or `hooks`, can now be passed through.

- `ClaudeAgent`: `maxTurns`, `env`, `allowedTools`, `disallowedTools`, `settingSources` and `systemPrompt` move to `sdkOptions`.
- `CodexAgent`: `modelReasoningEffort` becomes `effort`; client options (`codexPathOverride`, `baseUrl`, `apiKey`, `config`, `env`) move to `sdkOptions.client` and thread options (`sandboxMode`, `approvalPolicy`, `networkAccessEnabled`, `webSearchMode`, `additionalDirectories`) to `sdkOptions.thread`.
- `PiAgent`: `sessionOptions` is renamed to `sdkOptions` and `thinkingLevel` becomes the top-level `effort`.
