---
"@clankhouse/core": minor
---

Replace the wildcard `@clankhouse/core/*` export with curated entry points:

- `@clankhouse/core`: workflow API, `ClankHouse`, `renderPrompt`, and the coding agent, language model, run, session and artifact types
- `@clankhouse/core/git`: Git repositories and worktrees (unchanged)
- `@clankhouse/core/providers`: `BaseCodingAgent`, `BaseLanguageModel` and the types needed to implement agents and models
- `@clankhouse/core/internal`: helpers shared by first-party packages; unstable and not covered by semver

`@clankhouse/core` now also exports the `Workflows`, `WorkflowRuns`, `Artifacts` and `AISessions` types returned by `workflows()`, `runs()`, `artifacts()` and `sessions()`.

Deep imports such as `@clankhouse/core/clankhouse` or `@clankhouse/core/ai/coding-agent` no longer resolve.
