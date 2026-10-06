# `@clankhouse/anthropic`

The Anthropic language-model adapter for ClankHouse.

## Installation

```sh
pnpm add @clankhouse/anthropic @anthropic-ai/sdk
```

`@anthropic-ai/sdk` is a peer dependency, so you can upgrade it to get new models without waiting for a ClankHouse
release.

## Usage

`AnthropicModel` makes a single model call with no tools. Each `call` is a durable step, and the result is parsed and
typed against the `output` schema.

```ts
import { AnthropicModel } from "@clankhouse/anthropic"
import * as z from "zod"

const model = new AnthropicModel({ model: "claude-haiku-4-5", maxTokens: 1024 })

const { branch } = await model.call("name-branch", {
    prompt: `Suggest a git branch name for this task:\n${task}`,
    output: z.object({ branch: z.string() })
})
```

See the [main README](https://github.com/goyozi/clankhouse/blob/main/README.md) for a full walkthrough and concepts.
