We are working on Loopy, a local-first durable AI workflow framework.

## Modules

core:

- durable workflows, backed by sqlite (in-memory context via `AsyncLocalStorage`)
- prompt templating via Handlebars
- typed outputs based on zod schemas
- local Git repositories with worktrees
- artifacts (named workflow outputs)
- AI interfaces and session store
- event system

claude:

- `ClaudeAgent` - coding agent using `claude-agent-sdk`

test-utils:

- shared utils for testing Loopy workflows

## Testing

- use real temp files / directories / git repositories
- use fake implementations of `LanguageModel` and `CodingAgent`
- avoid mocking
- annotate each test body with `// given` / `// when` / `// then` / `// and` comments marking its logical phases, each with a short specific description

## Working Rules

- no new code comments unless specifically requested, except the BDD-style test ones
- minimal updates to existing comments if necessary (i.e. comment would otherwise be untrue or misleading)
- use `pnpm add` instead of modifying package.json directly
- use `pnpm` for typechecking, formatting, and linting
