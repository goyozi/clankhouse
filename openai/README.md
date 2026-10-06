# `@clankhouse/openai`

The OpenAI language-model adapter for ClankHouse.

## Installation

```sh
pnpm add @clankhouse/openai
```

## Usage

`OpenAIModel` makes a single model call with no tools. Each `call` is a durable step, and the result is parsed and typed
against the `output` schema.

```ts
import { OpenAIModel } from "@clankhouse/openai"
import * as z from "zod"

const model = new OpenAIModel({ model: "gpt-5.6-luna" })

const { branch } = await model.call("name-branch", {
    prompt: `Suggest a git branch name for this task:\n${task}`,
    output: z.object({ branch: z.string() })
})
```

See the [main README](https://github.com/goyozi/clankhouse/blob/main/README.md) for a full walkthrough and concepts.
