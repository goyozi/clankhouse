# `@clankhouse/codex`

The Codex coding-agent adapter for ClankHouse, powered by `@openai/codex-sdk`.

## Installation

```sh
pnpm add @clankhouse/codex @openai/codex-sdk
```

`@openai/codex-sdk` is a peer dependency, so you can upgrade it to get new models without waiting for a ClankHouse
release.

## Usage

`CodexAgent` is a coding agent that works inside a Git worktree and can change files. Each `run` is a durable step: the
result is parsed and typed against the `output` schema, and the worktree is snapshotted afterwards.

```ts
import { CodexAgent } from "@clankhouse/codex"
import { GitRepository } from "@clankhouse/core/git"
import * as z from "zod"

const agent = new CodexAgent({ model: "gpt-5.6-sol", effort: "high" })

async function implement({ repository }: { repository: string }): Promise<string> {
    const worktree = await new GitRepository(repository).worktree({ base: "HEAD" })

    return agent.run("implement", {
        prompt: "Implement the feature described in TODO.md and summarize what you changed.",
        output: z.string(),
        worktree
    })
}
```

Pass `snapshot: false` for sessions that only read, and `z.void()` as the output when you only care about the changes.

See the [main README](https://github.com/goyozi/clankhouse/blob/main/README.md) for a full walkthrough and concepts.
