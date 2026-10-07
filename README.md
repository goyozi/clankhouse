# ClankHouse

Local-first durable AI workflows, written in plain TypeScript.

**Status:** In early development. APIs may change often and break between minor versions.

## Features

- mix coding agents (Claude, Codex, Pi) and plain LLM calls in a single workflow
- resume a workflow run after a crash (or computer restart)
- re-run from a given step after failure or a workflow tweak
- agents work in isolated worktrees
- everything stays on your machine! (unless you use a cloud model, of course ;))

## Install the CLI

Node.js 22.x or newer is required.

```sh
npm install --global clankhouse
clank --help
```

```sh
pnpm add --global clankhouse
clank --help
```

`clank` talks to the ClankHouse server your workflow project starts (see below).

## Quick Start: Review-Fix Loop

This workflow has a coding agent review your branch and fix what it finds, for up to three rounds. The fixes are
applied to your working tree as uncommitted changes.

### Prerequisites

- ClankHouse CLI
- Git
- a coding agent you're signed in to: [Claude Code](https://claude.com/product/claude-code),
  [Codex](https://openai.com/codex/), or [Pi](https://pi.dev/)

### Set Up

Create a project for your workflows:

```sh
mkdir my-workflows && cd my-workflows
npm init -y && npm pkg set type=module
npm install @clankhouse/core @clankhouse/server zod tsx
```

Install the agent you use:

| Agent  | Install                                                         | Create                                                             |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Claude | `npm install @clankhouse/claude @anthropic-ai/claude-agent-sdk` | `new ClaudeAgent({ model: "claude-opus-5-5" })`                    |
| Codex  | `npm install @clankhouse/codex @openai/codex-sdk`               | `new CodexAgent({ model: "gpt-5.6-sol" })`                         |
| Pi     | `npm install @clankhouse/pi @earendil-works/pi-coding-agent`    | `new PiAgent({ provider: "anthropic", model: "claude-opus-5-5" })` |

Save this as `review-fix.ts`, swapping in your agent:

```ts
import { randomUUID } from "node:crypto"
import { ClaudeAgent } from "@clankhouse/claude"
// import { CodexAgent } from "@clankhouse/codex"
// import { PiAgent } from "@clankhouse/pi"
import { registerWorkflow, step } from "@clankhouse/core"
import { GitRepository } from "@clankhouse/core/git"
import { serve } from "@clankhouse/server"
import * as z from "zod"

const agent = new ClaudeAgent({ model: "claude-opus-5-5" })
// const agent = new CodexAgent({ model: "gpt-5.6-sol" })
// const agent = new PiAgent({ provider: "anthropic", model: "claude-opus-5-5" })

const Input = z.object({ repository: z.string(), base: z.string().default("main") })
const Review = z.object({ findings: z.array(z.string()) })

async function reviewFix({ repository, base }: z.infer<typeof Input>): Promise<void> {
    const repo = new GitRepository(repository)
    // Check out HEAD in a separate worktree, so the agent doesn't touch your files
    const worktree = await repo.worktree({ base: "HEAD" })

    for (let round = 1; round <= 3; round++) {
        // Review the branch, returning findings that match the Review schema
        const { findings } = await agent.run(`review-${round}`, {
            prompt: `Review the changes since ${base}, committed or not. List only issues worth fixing before merging. Don't change any files.`,
            output: Review,
            worktree,
            snapshot: false
        })
        if (findings.length === 0) break

        // Fix the findings in the worktree
        await agent.run(`fix-${round}`, {
            prompt: `Fix these review findings and leave your changes uncommitted:\n- ${findings.join("\n- ")}`,
            output: z.void(),
            worktree
        })
    }

    // Copy the fixes into your repository as uncommitted changes
    await step("apply-changes", z.void(), () => repo.applyChanges(worktree))
}

registerWorkflow("review-fix", { input: Input, output: z.void(), key: () => randomUUID() }, reviewFix)

const server = await serve()
console.log(`ClankHouse listening at ${server.url}`)
```

Start the server:

```sh
npx tsx review-fix.ts
```

### Run It From Any Repository

Add this to your `~/.zshrc` or `~/.bashrc`:

```sh
review-fix() {
    local run_id
    run_id=$(printf '{"repository":"%s","base":"%s"}' "$(git rev-parse --show-toplevel)" "${1:-main}" |
        clank runs start review-fix --input -) || return
    clank runs watch "$run_id"
}
```

Then commit your work and run it from your feature branch:

```sh
review-fix          # compare against main
review-fix develop  # or another base
```

The agent works in a separate worktree, so you can keep working while it runs. Your working tree has to be clean when
the fixes are applied at the end. If it isn't, the last step fails; clean up and `clank runs resume <run-id>`.

### Iterate on It

Every step's result is stored, so you can reuse previous results when iterating:

```sh
clank runs get <run-id> --include sessions   # what each agent did
clank runs resume <run-id>                   # continue an interrupted or failed run
clank runs rerun <run-id> --from fix-1       # tweak a prompt, rerun from that step on
```

The server resumes interrupted runs automatically when it starts. If you restart it mid-run, the run continues from the
last finished step.

## More Examples

- [hello-world](examples/hello-world): the smallest workflow, an agent writing a program in a fresh repository
- [dual-review](examples/dual-review): code review by Claude and Codex
- [factory](examples/factory): a small software factory. Drop a Markdown task in a folder, and it gets implemented,
  reviewed, fixed and tested.

## Concepts

### Workflows and Runs

A workflow is an async function registered under a name, with zod schemas for its input and output:

```ts
const Input = z.object({ repository: z.string(), issue: z.number() })

registerWorkflow(
    "fix-issue",
    { input: Input, output: z.void(), key: ({ repository, issue }) => `${repository}#${issue}` },
    async ({ repository, issue }) => {
        // steps, agents and models go here
    }
)
```

The `key` function derives a run key from the input: **starting a workflow again with the same key returns the existing
run instead of creating another.** Each execution is a run, stored in SQLite under `~/.clankhouse` (override with
`CLANKHOUSE_DIR`).

### Steps

Steps are the durable units of a workflow. When a step finishes, its result is recorded. If the run is resumed or
rerun, finished steps return their recorded result and do not run again. Everything else in the workflow function runs
again on replay, so anything slow, costly, or with side effects belongs in a step.

`step(name, schema, fn)` wraps any async function:

```ts
const details = await step("fetch-issue", Issue, () => fetchIssue(repository, issue))
```

Step names must be unique within a run. `prefix(name, fn)` namespaces the steps inside it, e.g. for loop iterations:

```ts
for (let attempt = 1; attempt <= 3; attempt++) {
    // records "attempt-1/fix", "attempt-1/run-tests", "attempt-2/fix", ...
    const passed = await prefix(`attempt-${attempt}`, async () => {
        await agent.run("fix", { prompt: details.body, output: z.void(), worktree })
        return step("run-tests", z.boolean(), () => runTests(worktree.path))
    })
    if (passed) break
}
```

### Agents and Models

Coding agents (`CodingAgent`) work inside a Git worktree and can change files:

| Package              | Class         | SDK (peer dependency)             |
| -------------------- | ------------- | --------------------------------- |
| `@clankhouse/claude` | `ClaudeAgent` | `@anthropic-ai/claude-agent-sdk`  |
| `@clankhouse/codex`  | `CodexAgent`  | `@openai/codex-sdk`               |
| `@clankhouse/pi`     | `PiAgent`     | `@earendil-works/pi-coding-agent` |

```ts
const agent = new CodexAgent({ model: "gpt-5.6-sol", effort: "high" })

const summary = await agent.run("implement", {
    prompt: "Implement the feature described in TODO.md and summarize what you changed.",
    output: z.string(),
    worktree
})
```

Language models (`LanguageModel`) make a single call with no tools:

| Package                 | Class            | SDK (peer dependency) |
| ----------------------- | ---------------- | --------------------- |
| `@clankhouse/anthropic` | `AnthropicModel` | `@anthropic-ai/sdk`   |
| `@clankhouse/openai`    | `OpenAIModel`    | `openai`              |

```ts
const model = new AnthropicModel({ model: "claude-haiku-4-5", maxTokens: 1024 })

const { branch } = await model.call("name-branch", {
    prompt: `Suggest a git branch name for this task:\n${task}`,
    output: z.object({ branch: z.string() })
})
```

Both agent and model calls are **steps** that take a prompt and a zod `output` schema, and the result is parsed and
typed against that schema. Pass `z.void()` when you only care about the changes the agent makes.

A prompt is either a string or a [Handlebars](https://handlebarsjs.com/) template file:

```ts
const reviewer = new PiAgent({ provider: "openai", model: "gpt-5.6-sol" })

const review = await reviewer.run("review", {
    prompt: { file: "prompts/review.md", vars: { requirements } },
    output: Review,
    worktree,
    snapshot: false
})
```

```md
Review the changes in this repository against these requirements:

{{requirements}}
```

Every session is recorded and can be inspected with `clank runs get <run-id> --include sessions`.

SDKs are peer dependencies, so you can upgrade them to get new models without waiting for a ClankHouse release.

### Worktrees

`new GitRepository(path).worktree({ base: "HEAD" })` creates an isolated worktree for agents to work in. Use
`includeUncommitted: true` instead of `base` to start from your current uncommitted state. After an agent session
finishes, its worktree is snapshotted, and the snapshot is restored on replay. Pass `snapshot: false` for sessions that
only read. When you're done:

- `repo.applyChanges(worktree)` brings the changes back as uncommitted changes. The repository must be clean.
- `worktree.commit(message)` and `worktree.push(branch)` publish them directly.

### Artifacts

`artifacts().writeText(name, text, mimeType)` stores a named output of the run, like a report or review. Use
`clank artifacts` to list and read them.

### Events and Triggers

- `waitFor({ key, schema })` pauses a run until an event arrives, e.g. a human approval sent with
  `clank events emit <key> --input -`.
- `addTrigger(source, workflow, { eventToInput })` starts runs automatically. Built-in sources: `fileCreated` and
  `fileCreatedIn`, e.g. a run for each Markdown task dropped into a folder.

### Server and CLI

`serve()` exposes registered workflows to the `clank` CLI. It also resumes interrupted runs on startup and cleans up
old runs and worktrees daily. The server binds to `127.0.0.1:7331` and generates an API key in
`~/.clankhouse/credentials.json` that the CLI reads.

```sh
clank workflows list
clank run <workflow> --input input.json   # start a run and print its output
clank ps                                  # running runs
clank runs list --workflow <workflow>
clank runs watch <run-id>
clank runs cancel <run-id>
```

### Scripting

You don't need the server to run a workflow: call `run(name, key, output, fn)` to execute one inline, e.g. in a
script or a test:

```ts
const model = new OpenAIModel({ model: "gpt-5.6-sol" })

const notes = await run("release-notes", "v0.3.0", z.string(), () =>
    model.call("summarize", { prompt: `Write release notes for:\n${changelog}`, output: z.string() })
)
```

### Testing

`@clankhouse/testing` has fake agents and models (`FakeCodingAgent`, `FakeLLM`) and helpers for temporary ClankHouse
instances and Git repositories, so you can test workflows with Vitest without making AI calls. See its
[README](testing/README.md) and the examples' tests.

## Known Gaps / Limitations

- one ClankHouse process per config directory (`CLANKHOUSE_DIR`)
- parallel steps may keep running after a run fails
- sharing worktrees and artifacts between workflows is not supported

## License

[MIT](LICENSE)
