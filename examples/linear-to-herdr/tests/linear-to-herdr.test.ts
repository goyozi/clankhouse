import type { ClankHouse, WorkflowRun } from "@clankhouse/core"
import { tempClankHouse, tempDir, waitForRun } from "@clankhouse/testing"
import { expect, onTestFinished, test } from "vitest"
import * as z from "zod"
import { LinearIssue, linearIssues } from "../src/linear"
import { createLinearToHerdrWorkflow, type LinearToHerdrOptions } from "../src/workflow"
import { FakeHerdr, FakeLinear, issue } from "./fakes"

test("a Todo issue opens a conversation in the repository and moves to In Progress", async () => {
    // given a Todo issue assigned to the user
    const linear = new FakeLinear()
    linear.add(issue(), "Todo")
    const herdr = new FakeHerdr()
    const repositoryPath = tempDir("linear-to-herdr-repo")
    const { clankhouse } = tempClankHouse()

    // when the Linear event source triggers the workflow
    startLinearToHerdr(clankhouse, {
        linear,
        herdr,
        repositoryPath,
        agentKind: "codex",
        inProgressState: "In Progress"
    })
    const run = await finishedRun(clankhouse)

    // then the run for the issue succeeds
    expect(run.status).toBe("succeeded")
    expect(run.key).toBe("issue-1")
    // and a conversation is opened in the repository with the issue's agent name, label and the agent kind
    expect(herdr.conversations).toHaveLength(1)
    const [conversation] = herdr.conversations
    expect(conversation).toMatchObject({ cwd: repositoryPath, name: "eng-42", label: "ENG-42", kind: "codex" })
    // and the prompt describes the issue
    expect(conversation.prompt).toContain("ENG-42")
    expect(conversation.prompt).toContain("Fix the login form")
    expect(conversation.prompt).toContain("The submit button does nothing.")
    // and the issue is moved to In Progress
    expect(linear.stateOf("issue-1")).toBe("In Progress")
})

test("an issue emitted by two polls leads to one run and one conversation", async () => {
    // given a Todo issue that stays in Todo after its run
    const linear = new FakeLinear()
    linear.add(issue(), "Todo")
    const herdr = new FakeHerdr()
    const { clankhouse } = tempClankHouse()
    startLinearToHerdr(clankhouse, {
        linear,
        herdr,
        repositoryPath: tempDir("linear-to-herdr-repo"),
        agentKind: "claude",
        inProgressState: "Todo"
    })

    // when the issue is emitted by two more polls after its run finished
    await finishedRun(clankhouse)
    const polls = linear.queries.length
    await until(() => linear.queries.length >= polls + 2)

    // then there's a single run and a single conversation
    expect(await clankhouse.runs.list({ workflowName: "linear-to-herdr" })).toHaveLength(1)
    expect(herdr.conversations).toHaveLength(1)
})

test("a Herdr failure fails the run and leaves the issue in Todo", async () => {
    // given a Todo issue and a Herdr session that isn't running
    const linear = new FakeLinear()
    linear.add(issue(), "Todo")
    const herdr = new FakeHerdr()
    herdr.failure = new Error("herdr workspace create failed: server_not_running")
    const { clankhouse } = tempClankHouse()

    // when the issue triggers a run
    startLinearToHerdr(clankhouse, {
        linear,
        herdr,
        repositoryPath: tempDir("linear-to-herdr-repo"),
        agentKind: "claude",
        inProgressState: "In Progress"
    })
    const run = await finishedRun(clankhouse)

    // then the run fails with Herdr's error
    expect(run.status).toBe("failed")
    expect(run.error).toContain("server_not_running")
    // and the issue stays in Todo
    expect(linear.stateOf("issue-1")).toBe("Todo")
})

test("an issue without a description still renders", async () => {
    // given a Todo issue without a description
    const linear = new FakeLinear()
    linear.add(issue({ description: null }), "Todo")
    const herdr = new FakeHerdr()
    const { clankhouse } = tempClankHouse()

    // when the issue triggers a run
    startLinearToHerdr(clankhouse, {
        linear,
        herdr,
        repositoryPath: tempDir("linear-to-herdr-repo"),
        agentKind: "claude",
        inProgressState: "In Progress"
    })
    const run = await finishedRun(clankhouse)

    // then the run succeeds with a prompt containing the identifier and title
    expect(run.status).toBe("succeeded")
    expect(herdr.conversations[0].prompt).toContain("# ENG-42: Fix the login form")
    expect(herdr.conversations[0].prompt).not.toContain("null")
})

function startLinearToHerdr(clankhouse: ClankHouse, options: LinearToHerdrOptions & { linear: FakeLinear }): void {
    const linearToHerdr = clankhouse.registerWorkflow(
        "linear-to-herdr",
        { input: LinearIssue, output: z.void(), key: (issue) => issue.id },
        createLinearToHerdrWorkflow(options, clankhouse)
    )
    clankhouse.addTrigger(linearIssues(options.linear, { state: "Todo", intervalMs: 10 }), linearToHerdr, {
        onError: () => {}
    })
    onTestFinished(() => clankhouse.close())
}

async function finishedRun(clankhouse: ClankHouse): Promise<WorkflowRun> {
    let runs = await clankhouse.runs.list({ workflowName: "linear-to-herdr" })
    while (runs.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        runs = await clankhouse.runs.list({ workflowName: "linear-to-herdr" })
    }
    return waitForRun(clankhouse, runs[0].id)
}

async function until(condition: () => boolean): Promise<void> {
    while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5))
}
