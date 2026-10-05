---
"@clankhouse/anthropic": minor
"@clankhouse/claude": minor
"@clankhouse/codex": minor
"@clankhouse/pi": minor
---

Make provider SDKs peer dependencies

`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@earendil-works/pi-coding-agent` and `@anthropic-ai/sdk` are now peer dependencies with wide ranges, so you can upgrade them to pick up new models without waiting for a ClankHouse release. Install the SDK next to its adapter, e.g. `pnpm add @clankhouse/codex @openai/codex-sdk`, and run `pnpm update --latest <sdk>` to upgrade it.
