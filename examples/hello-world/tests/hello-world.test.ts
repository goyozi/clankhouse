import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FakeCodingAgent } from "@clankhouse/core/ai/fake-agent"
import { runGit, runOutput, tempClankHouse } from "@clankhouse/test-utils"
import { expect, onTestFinished, test } from "vitest"
import * as z from "zod"
import { createHelloWorldWorkflow } from "../src/workflow"

test("creates a distinct Git repository containing the fake agent implementation for every run", async () => {
    // given a temporary ClankHouse instance and fake coding agent that creates hello.py
    const { clankhouse } = tempClankHouse()
    const invocations: { stepName: string; prompt: string }[] = []
    const agent = new FakeCodingAgent((stepName, prompt) => {
        invocations.push({ stepName, prompt })
        return {
            changes: [{ file: "hello.py", text: 'print("Hello, World!")\n' }],
            output: undefined
        }
    })
    const directories: string[] = []
    onTestFinished(() => {
        for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
    })

    // and a caller-owned registration matching the runnable server
    clankhouse.registerWorkflow(
        "hello-world",
        {
            input: z.void(),
            output: z.string(),
            key: () => randomUUID()
        },
        createHelloWorldWorkflow(agent, clankhouse)
    )

    // when the workflow is run twice
    const firstRunId = clankhouse.start("hello-world")
    const secondRunId = clankhouse.start("hello-world")
    directories.push(
        z.string().parse(await runOutput(clankhouse, firstRunId)),
        z.string().parse(await runOutput(clankhouse, secondRunId))
    )

    // then each run has a distinct key and output directory under the system temporary directory
    const [firstRun, secondRun] = await Promise.all([clankhouse.runs.get(firstRunId), clankhouse.runs.get(secondRunId)])
    expect(firstRun.key).not.toBe(secondRun.key)
    expect(directories[0]).not.toBe(directories[1])
    expect(
        directories.every((directory) => directory.startsWith(path.join(os.tmpdir(), "clankhouse-hello-world-")))
    ).toBe(true)

    // and each output is a Git repository containing the exact fake implementation
    for (const directory of directories) {
        expect(await runGit(directory, ["rev-parse", "--is-inside-work-tree"])).toBe("true")
        expect(fs.readFileSync(path.join(directory, "hello.py"), "utf8")).toBe('print("Hello, World!")\n')
    }

    // and the fake agent received the expected implementation instruction for both runs
    expect(invocations).toEqual([
        {
            stepName: "implement",
            prompt: 'Create a Python program in hello.py that prints exactly "Hello, World!" when run.'
        },
        {
            stepName: "implement",
            prompt: 'Create a Python program in hello.py that prints exactly "Hello, World!" when run.'
        }
    ])
})
