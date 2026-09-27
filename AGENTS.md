We are working on ClankHouse, a local-first durable AI workflow framework.

Note: since we're pre-0.1 without any real world users, there's no need to maintain backwards compatibility and do database migrations.

## Modules

Modules are located in the repo root (no `packages/` directory).

core:

- durable workflows, backed by sqlite (in-memory context via `AsyncLocalStorage`)
- prompt templating via Handlebars
- typed outputs based on zod schemas
- local Git repositories with worktrees
- artifacts (named workflow outputs)
- AI interfaces and session store
- event system

server:

- serving workflows via Connect RPC

protocol:

- Protocol Buffers schema and generated TypeScript descriptors shared by clients and servers

cli:

- CLI for communicating with the server

claude / codex / pi:

- `ClaudeAgent` - coding agent using `claude-agent-sdk`
- `CodexAgent` - coding agent using `@openai/codex-sdk`
- `PiAgent` - coding agent using `@earendil-works/pi-coding-agent`

anthropic / openai

- `AnthropicModel` using `@anthropic-ai/sdk`
- `OpenAIModel` using `openai`

test-utils:

- shared utils for testing ClankHouse workflows

examples:

- hello-world - basic ClankHouse workflow example
- dual-review - code review by Claude & Codex

design:

- web page for CLI output design

## Operating Assumptions

- one user, one ClankHouse process per directory; runs take minutes to hours
- gc runs occasionally (e.g. daily) with age thresholds measured in days
- prefer simple, idempotent designs over in-memory coordination; a new tracking mechanism, table, lock, or
  crash-safety protocol needs a realistic scenario under these assumptions to justify it

## Known Gaps

Don't design around these unless the task targets them:

- a run can be marked failed while its parallel branches are still executing steps (`Promise.all` rejects early)
- multiple processes sharing one ClankHouse directory are not coordinated
- references into another run (artifacts, worktrees) are weak and may dangle after that run is deleted

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
- run `zizmor --pedantic --strict-collection --no-ignores <file>` after all GH actions pipeline changes
