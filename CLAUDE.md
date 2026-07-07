We are working on Loopy, a local-first durable AI workflow framework.

Currently, we're building Loopy Core, which will cover:

- durable workflows, backed by sqlite (in-memory context via `AsyncLocalStorage`)
- prompt templating via Handlebars
- typed outputs based on zod schemas
- local Git repositories with worktrees
- artifacts (named workflow outputs)
- AI interfaces and session store
- event system

Testing strategy:

- use real temp files / directories / git repositories
- use fake implementations of `LanguageModel` and `CodingAgent`
- avoid mocking
- annotate each test body with `// given` / `// when` / `// then` / `// and` comments marking its logical phases, each with a short specific description

Working rules:

- no new code comments unless specifically requested, except the BDD-style test ones
- minimal updates to existing comments if necessary (i.e. comment would otherwise be untrue or misleading)
- use `pnpm add` instead of modifying package.json directly
