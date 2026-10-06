# `@clankhouse/core`

The durable, local-first workflow runtime used by ClankHouse. It provides workflow execution, SQLite-backed state,
artifacts, event sources, AI session recording, and Git worktree support.

## Installation

```sh
pnpm add @clankhouse/core zod
```

## Usage

A workflow is an async function registered under a name, with zod schemas for its input and output. Steps are its
durable units: when a step finishes, its result is recorded, and it won't run again on resume or rerun.

This one runs a test command repeatedly to check whether it's flaky. If the process dies halfway, resuming the run
continues from the last finished attempt:

```ts
import { randomUUID } from "node:crypto"
import { registerWorkflow, step } from "@clankhouse/core"
import * as z from "zod"

const Input = z.object({
    repository: z.string(),
    command: z.string().default("npm test"),
    attempts: z.number().default(20)
})
const Output = z.object({ passed: z.number(), failed: z.number() })

// implement testsPass here

registerWorkflow(
    "check-flaky-tests",
    { input: Input, output: Output, key: () => randomUUID() },
    async ({ repository, command, attempts }) => {
        let passed = 0
        for (let attempt = 1; attempt <= attempts; attempt++) {
            if (await step(`attempt-${attempt}`, z.boolean(), () => testsPass(repository, command))) passed++
        }
        return { passed, failed: attempts - passed }
    }
)
```

Agents work in isolated Git worktrees:

```ts
import { GitRepository } from "@clankhouse/core/git"

// in a workflow function:
const repo = new GitRepository(repository)
const worktree = await repo.worktree({ base: "HEAD" })
// ... let an agent change files in worktree.path
await step("apply-changes", z.void(), () => repo.applyChanges(worktree))
```

You don't need a server to run a workflow, `run(name, key, output, fn)` executes one inline:

```ts
import { run } from "@clankhouse/core"

// in a workflow function:
const notes = await run("release-notes", "v0.3.0", z.string(), () =>
    model.call("summarize", { prompt: `Write release notes for:\n${changelog}`, output: z.string() })
)
```

See the [main README](https://github.com/goyozi/clankhouse/blob/main/README.md) for a full walkthrough and concepts.
