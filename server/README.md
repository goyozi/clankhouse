# `@clankhouse/server`

The Connect RPC server for exposing ClankHouse workflows to local and remote clients.

## Installation

```sh
pnpm add @clankhouse/server @clankhouse/core
```

## Usage

`serve()` exposes registered workflows to the [`clank` CLI](https://www.npmjs.com/package/clankhouse).
It also resumes interrupted runs on startup and cleans up old runs and worktrees daily.

```ts
import { registerWorkflow } from "@clankhouse/core"
import { serve } from "@clankhouse/server"

// put async function myWorkflow here

registerWorkflow("my-workflow", { input: Input, output: z.void(), key: () => randomUUID() }, myWorkflow)

const server = await serve()
console.log(`ClankHouse listening at ${server.url}`)
```

The server binds to `127.0.0.1:7331` and generates an API key in `~/.clankhouse/credentials.json` that the CLI reads.

See the [main README](https://github.com/goyozi/clankhouse/blob/main/README.md) for a full walkthrough and concepts.
