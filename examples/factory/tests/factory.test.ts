import * as fs from "node:fs"
import * as path from "node:path"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { FakeCodingAgent, type FakeAgentResult } from "@clankhouse/core/ai/fake-agent"
import type { WorkflowRun } from "@clankhouse/core/runs"
import { tempGitRepo, tempClankHouse, waitForRun, type TempGitRepo } from "@clankhouse/test-utils"
import { expect, onTestFinished, test, vi } from "vitest"
import * as z from "zod"
import { watchTasks } from "../src/tasks"
import { createFactoryWorkflow, FactoryInput, type FactoryAgents } from "../src/workflow"

type Invocation = { stepName: string; prompt: string }

const responses: Record<string, FakeAgentResult> = {
    implement: { changes: [{ file: "feature.txt", text: "implemented\n" }], output: undefined },
    "review-code-1": { changes: [], output: { findings: ["first code review"] } },
    "review-code-2": { changes: [], output: { findings: ["second code review"] } },
    "synthesize-code-review": {
        changes: [],
        output: { act: ["rename the file contents"], skip: [], anotherReviewNeeded: false }
    },
    "fix-review-findings": {
        changes: [{ file: "feature.txt", oldText: "implemented", newText: "implemented and fixed" }],
        output: undefined
    },
    "test-application": { changes: [], output: "exercised the feature" }
}

test("a task moved into implementation is implemented, reviewed, applied, and moved to done", async () => {
    // given a repository with ignored task directories and committed testing instructions
    const repo = await factoryRepo({ testingInstructions: "Run the app and click around.\n" })
    const { clankhouse } = tempClankHouse()
    const invocations: Invocation[] = []
    startFactory(clankhouse, repo, invocations)

    // when a task is moved from requirements into implementation
    repo.write("factory/requirements/MY-123-fix-login.md", "Fix the login form.\n")
    fs.renameSync(
        path.join(repo.path, "factory/requirements/MY-123-fix-login.md"),
        path.join(repo.path, "factory/implementation/MY-123-fix-login.md")
    )
    const run = await finishedRun(clankhouse)

    // then the run succeeds
    expect(run.status).toBe("succeeded")
    expect(run.key).toBe(path.join(repo.path, "factory/implementation/MY-123-fix-login.md"))
    // and the fixed implementation is applied to the repository's working tree
    expect(repo.read("feature.txt")).toBe("implemented and fixed\n")
    // and the task ends up in done
    expect(repo.exists("factory/implementation/MY-123-fix-login.md")).toBe(false)
    expect(repo.read("factory/done/MY-123-fix-login.md")).toBe("Fix the login form.\n")
    // and the agents run in pipeline order
    const stepNames = invocations.map((invocation) => invocation.stepName)
    expect(stepNames[0]).toBe("implement")
    expect(stepNames.slice(1, 3).sort()).toEqual(["review-code-1", "review-code-2"])
    expect(stepNames.slice(3)).toEqual(["synthesize-code-review", "fix-review-findings", "test-application"])
    // and each prompt carries the task and the reviews it needs
    const prompt = (stepName: string) => invocations.find((invocation) => invocation.stepName === stepName)!.prompt
    expect(prompt("implement")).toContain("Fix the login form.")
    expect(prompt("review-code-2")).toContain("Fix the login form.")
    expect(prompt("synthesize-code-review")).toContain("first code review")
    expect(prompt("synthesize-code-review")).toContain("second code review")
    expect(prompt("fix-review-findings")).toContain("- rename the file contents")
    expect(prompt("test-application")).toContain("Run the app and click around.")
    // and the reviews and test report are stored as artifacts
    expect(run.artifacts.map((artifact) => artifact.name)).toEqual([
        "code-review-1-1",
        "code-review-1-2",
        "code-review-1",
        "test-report"
    ])
})

test("application testing is skipped when the repository has no testing instructions", async () => {
    // given a repository without testing instructions
    const repo = await factoryRepo({})
    const { clankhouse } = tempClankHouse()
    const invocations: Invocation[] = []
    startFactory(clankhouse, repo, invocations)

    // when a task is placed into implementation
    repo.write("factory/implementation/MY-124-add-logout.md", "Add a logout button.\n")
    const run = await finishedRun(clankhouse)

    // then the run succeeds without the application testing stage or its report
    expect(run.status).toBe("succeeded")
    expect(invocations.map((invocation) => invocation.stepName)).not.toContain("test-application")
    expect(run.artifacts.map((artifact) => artifact.name)).not.toContain("test-report")
    // and the task still ends up in done
    expect(repo.exists("factory/done/MY-124-add-logout.md")).toBe(true)
})

test("review fixes are skipped when the verified code review has nothing to act on", async () => {
    // given a factory whose code review synthesis finds nothing to act on despite asking for another review
    const repo = await factoryRepo({})
    const { clankhouse } = tempClankHouse()
    const invocations: Invocation[] = []
    startFactory(clankhouse, repo, invocations, {
        overrides: {
            "synthesize-code-review": [verifiedReview({ act: [], skip: ["nitpick"], anotherReviewNeeded: true })]
        }
    })

    // when a task is placed into implementation
    repo.write("factory/implementation/MY-127-typo.md", "Fix a typo.\n")
    const run = await finishedRun(clankhouse)

    // then the run succeeds without running the fixer
    expect(run.status).toBe("succeeded")
    expect(invocations.map((invocation) => invocation.stepName)).not.toContain("fix-review-findings")
    // and the unfixed implementation is applied
    expect(repo.read("feature.txt")).toBe("implemented\n")
})

test("fixes are reviewed again until the verified code review has nothing to act on", async () => {
    // given a factory whose first verified review asks for another review after fixing
    const repo = await factoryRepo({})
    const { clankhouse } = tempClankHouse()
    const invocations: Invocation[] = []
    startFactory(clankhouse, repo, invocations, {
        overrides: {
            "synthesize-code-review": [
                verifiedReview({ act: ["redesign the feature"], skip: ["rename the file"], anotherReviewNeeded: true }),
                verifiedReview({ skip: ["nitpick"], anotherReviewNeeded: false })
            ]
        }
    })

    // when a task is placed into implementation
    repo.write("factory/implementation/MY-128-redesign.md", "Redesign the feature.\n")
    const run = await finishedRun(clankhouse)

    // then the run succeeds after two review rounds with a single fix in between
    expect(run.status).toBe("succeeded")
    const stepNames = invocations.map((invocation) => invocation.stepName)
    expect(stepNames.filter((stepName) => stepName === "synthesize-code-review")).toHaveLength(2)
    expect(stepNames.filter((stepName) => stepName === "fix-review-findings")).toHaveLength(1)
    expect(stepNames.slice(stepNames.indexOf("fix-review-findings") + 1).sort()).toEqual([
        "review-code-1",
        "review-code-2",
        "synthesize-code-review"
    ])
    // and each round's reviews are stored as artifacts
    expect(run.artifacts.map((artifact) => artifact.name).filter((name) => name.startsWith("code-review"))).toEqual([
        "code-review-1-1",
        "code-review-1-2",
        "code-review-1",
        "code-review-2-1",
        "code-review-2-2",
        "code-review-2"
    ])
})

test("the review loop stops after three rounds", async () => {
    // given a factory whose verified reviews always ask for another review
    const repo = await factoryRepo({})
    const { clankhouse } = tempClankHouse()
    const invocations: Invocation[] = []
    startFactory(clankhouse, repo, invocations, {
        overrides: {
            "synthesize-code-review": [verifiedReview({ act: ["try again"], skip: [], anotherReviewNeeded: true })]
        }
    })

    // when a task is placed into implementation
    repo.write("factory/implementation/MY-129-endless.md", "Never be done.\n")
    const run = await finishedRun(clankhouse)

    // then the run succeeds after three review rounds, each followed by fixes
    expect(run.status).toBe("succeeded")
    const stepNames = invocations.map((invocation) => invocation.stepName)
    expect(stepNames.filter((stepName) => stepName === "synthesize-code-review")).toHaveLength(3)
    expect(stepNames.filter((stepName) => stepName === "fix-review-findings")).toHaveLength(3)
    // and every round's fixes are applied
    expect(repo.read("feature.txt")).toBe("implemented and fixed and fixed and fixed\n")
})

test("a task already in implementation when the factory starts is picked up", async () => {
    // given a task that was left in implementation while the factory was not running
    const repo = await factoryRepo({})
    repo.write("factory/implementation/MY-125-dark-mode.md", "Add dark mode.\n")
    const { clankhouse } = tempClankHouse()

    // when the factory starts watching the repository
    startFactory(clankhouse, repo, [])
    const run = await finishedRun(clankhouse)

    // then the task is implemented and moved to done
    expect(run.status).toBe("succeeded")
    expect(repo.exists("factory/done/MY-125-dark-mode.md")).toBe(true)
})

test("a failed task stays in implementation and is not reported again after a restart", async () => {
    // given a factory whose implementer fails
    const repo = await factoryRepo({})
    const { clankhouse, reopen } = tempClankHouse()
    startFactory(clankhouse, repo, [], { failingStep: "implement" })

    // when a task is placed into implementation
    repo.write("factory/implementation/MY-126-broken.md", "Break everything.\n")
    const failed = await finishedRun(clankhouse)

    // then the run fails and the task stays in implementation for a rerun
    expect(failed.status).toBe("failed")
    expect(repo.exists("factory/implementation/MY-126-broken.md")).toBe(true)
    expect(repo.exists("factory/done/MY-126-broken.md")).toBe(false)

    // when the factory restarts and observes the failed task again
    clankhouse.close()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    onTestFinished(() => errors.mockRestore())
    const restarted = reopen()
    startFactory(restarted, repo, [])
    await new Promise((resolve) => setTimeout(resolve, 100))

    // then no new attempt is started and no error is reported
    const runs = await restarted.runs.list({ workflowName: "factory" })
    expect(runs.map((run) => ({ id: run.id, status: run.status }))).toEqual([{ id: failed.id, status: "failed" }])
    expect(errors).not.toHaveBeenCalled()
})

function verifiedReview(review: { act?: string[]; skip: string[]; anotherReviewNeeded: boolean }): FakeAgentResult {
    return { changes: [], output: review }
}

async function factoryRepo({ testingInstructions }: { testingInstructions?: string }): Promise<TempGitRepo> {
    const repo = await tempGitRepo()
    repo.write(".gitignore", "factory/requirements/\nfactory/implementation/\nfactory/done/\n")
    if (testingInstructions !== undefined) repo.write("factory/testing.md", testingInstructions)
    await repo.commitAll("set up factory")
    return repo
}

function startFactory(
    clankhouse: ClankHouse,
    repo: TempGitRepo,
    invocations: Invocation[],
    { failingStep, overrides = {} }: { failingStep?: string; overrides?: Record<string, FakeAgentResult[]> } = {}
) {
    const agent = new FakeCodingAgent((stepName, prompt) => {
        const call = invocations.filter((invocation) => invocation.stepName === stepName).length
        invocations.push({ stepName, prompt })
        if (stepName === failingStep) throw new Error(`${stepName} failed`)
        const sequence = overrides[stepName]
        return sequence ? sequence[Math.min(call, sequence.length - 1)] : responses[stepName]
    })
    const agents: FactoryAgents = {
        implementer: agent,
        codeReviewer1: agent,
        codeReviewer2: agent,
        codeReviewSynthesizer: agent,
        fixer: agent,
        applicationTester: agent
    }
    const factory = clankhouse.registerWorkflow(
        "factory",
        { input: FactoryInput, output: z.void(), key: ({ task }) => task },
        createFactoryWorkflow(agents, clankhouse)
    )
    watchTasks(clankhouse, repo.path, factory)
}

async function finishedRun(clankhouse: ClankHouse): Promise<WorkflowRun> {
    let runs = await clankhouse.runs.list({ workflowName: "factory" })
    while (runs.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        runs = await clankhouse.runs.list({ workflowName: "factory" })
    }
    return waitForRun(clankhouse, runs[0].id)
}
