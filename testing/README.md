# `@clankhouse/testing`

Helpers for testing ClankHouse workflows with [Vitest](https://vitest.dev/): temporary ClankHouse instances, directories
and Git repositories, cleaned up after each test, plus fake agents and models that make no AI calls.

## Installation

```sh
pnpm add --save-dev @clankhouse/testing vitest
```

## Usage

`FakeCodingAgent` and `FakeLLM` take a function that receives the step name and prompt. A fake agent returns the file
changes to make in the worktree and the output to return:

```ts
import { FakeCodingAgent, runOutput, tempClankHouse, tempGitRepo } from "@clankhouse/testing"
import { expect, test } from "vitest"
import * as z from "zod"
import { createFixWorkflow } from "../src/workflow"

test("applies the agent's fix to the repository", async () => {
    // given a ClankHouse instance in a temporary directory and a Git repository with a typo
    const { clankhouse } = tempClankHouse()
    const repo = await tempGitRepo()
    repo.write("hello.txt", "Helo\n")
    await repo.commitAll("add greeting")

    // and a fake agent that fixes it
    const agent = new FakeCodingAgent(() => ({
        changes: [{ file: "hello.txt", oldText: "Helo", newText: "Hello" }],
        output: undefined
    }))
    clankhouse.registerWorkflow(
        "fix",
        { input: z.string(), output: z.void(), key: (repository) => repository },
        createFixWorkflow(agent)
    )

    // when the workflow runs
    await runOutput(clankhouse, clankhouse.start("fix", repo.path).runId)

    // then the fix is applied
    expect(repo.read("hello.txt")).toBe("Hello\n")
})
```

Other helpers:

- `tempDir(prefix)` creates a temporary directory
- `tempClankHouse()` returns a ClankHouse instance in a temporary directory, plus `reopen()` to simulate a restart
- `tempGitRepo()` creates a Git repository with an initial commit
- `runGit(cwd, args)` runs a Git command and returns its trimmed output
- `testRun(clankhouse, fn)` runs `fn` inline as a workflow, so you can test steps and agent calls without registering
  one
- `waitForRun(clankhouse, runId)` and `runOutput(clankhouse, runId)` wait for a run to finish
- `gate()` returns a promise you release by hand, to pause a step at a known point

See the [examples](https://github.com/goyozi/clankhouse/tree/main/examples) for complete workflows with tests.
