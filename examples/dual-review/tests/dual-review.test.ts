import * as fs from "node:fs"
import * as path from "node:path"
import type { CodingAgent, CodingRunOptions } from "@clankhouse/core/ai/coding-agent"
import { FakeCodingAgent } from "@clankhouse/core/ai/fake-agent"
import { gate, runGit, tempGitRepo, tempClankHouse, testRun } from "@clankhouse/test-utils"
import { expect, test } from "vitest"
import * as z from "zod"
import { createDualReviewWorkflow } from "../src/workflow"

test("reviews captured uncommitted changes and synthesizes both findings without snapshots", async () => {
    // given a repository with a nested launch directory plus staged and untracked changes
    const repo = await tempGitRepo()
    repo.write("nested/anchor.txt", "anchor\n")
    await repo.commitAll("add nested launch directory")
    repo.write("README.md", "staged change\n")
    await runGit(repo.path, ["add", "README.md"])
    repo.write("untracked.txt", "untracked change\n")
    const { clankhouse, dir } = tempClankHouse()
    const invocations: { agent: string; stepName: string; prompt: string }[] = []
    const reviewer1 = new FakeCodingAgent((stepName, prompt) => {
        invocations.push({ agent: "reviewer1", stepName, prompt })
        return { changes: [], output: "Reviewer1 finding" }
    })
    const reviewer2 = new FakeCodingAgent((stepName, prompt) => {
        invocations.push({ agent: "reviewer2", stepName, prompt })
        return { changes: [], output: "Reviewer2 finding" }
    })
    const synthesizer = new FakeCodingAgent((stepName, prompt) => {
        invocations.push({ agent: "synthesizer", stepName, prompt })
        return { changes: [], output: "Act: fix it\nSkip: none" }
    })
    const workflow = createDualReviewWorkflow({ reviewer1, reviewer2, synthesizer })

    // when the dual-review workflow runs with the nested repository path as input
    const output = await testRun(clankhouse, () => workflow({ repositoryPath: path.join(repo.path, "nested") }), {
        output: z.string()
    })

    // then the final agent output is the workflow output
    expect(output).toBe("Act: fix it\nSkip: none")
    // and both reviewers receive the full review prompt before synthesis receives both findings
    expect(invocations).toEqual([
        {
            agent: "reviewer1",
            stepName: "review-with-reviewer1",
            prompt: `Please review my uncommitted changes

Note: Only the tagged answer is read — nothing else you produce is passed on. Even if you report
findings through a tool (\`ReportFindings\` or anything similar), you must still write every
one of them out in full in the provided answer tags. Do not replace them with a pointer to the tool
output, a count, or a summary.`
        },
        {
            agent: "reviewer2",
            stepName: "review-with-reviewer2",
            prompt: `Please review my uncommitted changes

Note: Only the tagged answer is read — nothing else you produce is passed on. Even if you report
findings through a tool (\`ReportFindings\` or anything similar), you must still write every
one of them out in full in the provided answer tags. Do not replace them with a pointer to the tool
output, a count, or a summary.`
        },
        {
            agent: "synthesizer",
            stepName: "synthesize-reviews",
            prompt: `Verify and de-duplicate the findings, and combine them into a final prioritized Act/Skip list

Reviewer1 findings:
<reviewer1-findings>
Reviewer1 finding
</reviewer1-findings>

Reviewer2 findings:
<reviewer2-findings>
Reviewer2 finding
</reviewer2-findings>`
        }
    ])
    // and the durable worktree contains the staged and untracked source changes
    const run = await clankhouse.runs.get((await clankhouse.runs.list())[0].id)
    const worktreeStep = run.steps.find((step) => step.kind === "worktree")
    if (worktreeStep?.kind !== "worktree" || worktreeStep.output === undefined) throw new Error("unreachable")
    const checkout = path.join(dir, "worktrees", worktreeStep.output.id, "checkout")
    expect(fs.readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("staged change\n")
    expect(fs.readFileSync(path.join(checkout, "untracked.txt"), "utf8")).toBe("untracked change\n")
    // and all three string-valued agent steps completed without snapshot refs
    expect(
        run.steps
            .filter((step) => step.kind === "agent")
            .map((step) => ({
                key: step.key,
                output: step.output,
                snapshotRef: step.snapshotRef
            }))
    ).toEqual([
        { key: "review-with-reviewer1", output: "Reviewer1 finding", snapshotRef: undefined },
        { key: "review-with-reviewer2", output: "Reviewer2 finding", snapshotRef: undefined },
        { key: "synthesize-reviews", output: "Act: fix it\nSkip: none", snapshotRef: undefined }
    ])
})

test("waits for both reviewers to finish before propagating a review failure", async () => {
    // given one reviewer fails while the other remains in progress
    const repo = await tempGitRepo()
    const { clankhouse } = tempClankHouse()
    const reviewer2Started = gate()
    const reviewer2MayFinish = gate()
    let reviewer2Finished = false
    let synthesizerRan = false
    const reviewer1: CodingAgent = {
        async run() {
            throw new Error("Reviewer1 review failed")
        }
    }
    const reviewer2: CodingAgent = {
        async run<T extends z.ZodTypeAny>() {
            reviewer2Started.release()
            await reviewer2MayFinish.released
            reviewer2Finished = true
            return "Reviewer2 finding" as z.infer<T>
        }
    }
    const synthesizer: CodingAgent = {
        async run<T extends z.ZodTypeAny>() {
            synthesizerRan = true
            return "unexpected synthesis" as z.infer<T>
        }
    }
    const workflow = createDualReviewWorkflow({ reviewer1, reviewer2, synthesizer })

    // when the workflow starts both reviewers
    const workflowResult = testRun(clankhouse, () => workflow({ repositoryPath: repo.path }), { output: z.string() })
    let earlyFailure: unknown
    void workflowResult.catch((error: unknown) => {
        earlyFailure = error
    })
    await reviewer2Started.released
    await new Promise<void>((resolve) => setImmediate(resolve))

    // then the first failure remains pending until the sibling reviewer finishes
    expect(earlyFailure).toBeUndefined()

    // when the sibling reviewer finishes
    reviewer2MayFinish.release()

    // then the workflow propagates the review failure without running synthesis
    await expect(workflowResult).rejects.toThrow("Reviewer1 review failed")
    expect(reviewer2Finished).toBe(true)
    expect(synthesizerRan).toBe(false)
})

test("rewrites absolute worktree file references to the repository in the final result", async () => {
    // given a synthesis that references existing, missing, and deleted files in the durable worktree
    const repo = await tempGitRepo()
    const { clankhouse } = tempClankHouse()
    const reviewer1 = new FakeCodingAgent(() => ({ changes: [], output: "Reviewer1 finding" }))
    const reviewer2 = new FakeCodingAgent(() => ({ changes: [], output: "Reviewer2 finding" }))
    const repositoryPath = fs.realpathSync(repo.path)
    let worktreePath = ""
    const synthesizer: CodingAgent = {
        async run<T extends z.ZodTypeAny>(_stepName: string, options: CodingRunOptions<T>): Promise<z.infer<T>> {
            worktreePath = options.worktree.path
            return [
                `Act: fix ${path.join(worktreePath, "README.md")}:1`,
                `Act: restore ${path.join(worktreePath, "missing.ts")}`,
                `Skip: deleted ${path.join(worktreePath, "src", "deleted.ts")}`,
                `Compare ${path.join(worktreePath, "README.md")} with ${path.join(worktreePath, "missing.ts")}`
            ].join("\n") as z.infer<T>
        }
    }
    const workflow = createDualReviewWorkflow({ reviewer1, reviewer2, synthesizer })

    // when the workflow returns the synthesized review
    const output = await testRun(clankhouse, () => workflow({ repositoryPath: repo.path }), { output: z.string() })

    // then every worktree reference points to the source repository without checking file existence
    expect(output).toBe(
        [
            `Act: fix ${path.join(repositoryPath, "README.md")}:1`,
            `Act: restore ${path.join(repositoryPath, "missing.ts")}`,
            `Skip: deleted ${path.join(repositoryPath, "src", "deleted.ts")}`,
            `Compare ${path.join(repositoryPath, "README.md")} with ${path.join(repositoryPath, "missing.ts")}`
        ].join("\n")
    )
    // and no durable worktree path is exposed in the final result
    expect(output).not.toContain(worktreePath)
})
