import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { clankhouse } from "@clankhouse/core"
import type { CodingAgent } from "@clankhouse/core/ai/coding-agent"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { GitRepository, type Worktree } from "@clankhouse/core/git"
import { isNodeError } from "@clankhouse/core/util"
import * as z from "zod"
import { taskDirectory } from "./tasks"

export type FactoryAgents = {
    implementer: CodingAgent
    codeReviewer1: CodingAgent
    codeReviewer2: CodingAgent
    codeReviewSynthesizer: CodingAgent
    fixer: CodingAgent
    applicationTester: CodingAgent
}

export const FactoryInput = z.object({ repositoryPath: z.string(), task: z.string() })
export type FactoryInput = z.infer<typeof FactoryInput>

const CandidateReview = z.object({ findings: z.array(z.string()) })

const FinalReview = z.object({
    act: z.array(z.string()).optional(),
    skip: z.array(z.string()),
    anotherReviewNeeded: z.boolean()
})

type FinalReview = z.infer<typeof FinalReview>

type ReviewContext = { worktree: Worktree; requirements: string }

const MAX_CODE_REVIEW_ROUNDS = 3
const TESTING_INSTRUCTIONS = "factory/testing.md"

export function createFactoryWorkflow(
    agents: FactoryAgents,
    instance: ClankHouse = clankhouse()
): (input: FactoryInput) => Promise<void> {
    return async ({ repositoryPath, task }) => {
        const repository = new GitRepository(repositoryPath)
        const requirements = await instance.step("read-task", z.string(), () => readTask(task))
        const testingInstructions = await instance.step("read-testing-instructions", z.string().nullable(), () =>
            readOptional(path.join(repositoryPath, TESTING_INSTRUCTIONS))
        )

        const worktree = await repository.worktree({ base: "HEAD" })

        await agents.implementer.run("implement", {
            prompt: { file: prompt("implement"), vars: { requirements } },
            output: z.void(),
            worktree
        })

        await reviewAndFix(agents, instance, { worktree, requirements })

        if (testingInstructions !== null) {
            const testReport = await agents.applicationTester.run("test-application", {
                prompt: { file: prompt("test-application"), vars: { requirements, testingInstructions } },
                output: z.string(),
                worktree
            })
            await instance.artifacts.writeText("test-report", testReport, "text/markdown")
        }

        await instance.step("apply-changes", z.void(), () => repository.applyChanges(worktree))
        await instance.moveFile(
            "move-task-to-done",
            task,
            path.join(taskDirectory(repositoryPath, "done"), path.basename(task))
        )
    }
}

async function readTask(task: string): Promise<string> {
    const text = await readFile(task, "utf8")
    if (text.trim().length === 0) throw new Error(`Task is empty: ${task}`)
    return text
}

async function readOptional(file: string): Promise<string | null> {
    try {
        return await readFile(file, "utf8")
    } catch (error) {
        if (isNodeError(error, "ENOENT")) return null
        throw error
    }
}

async function reviewAndFix(agents: FactoryAgents, instance: ClankHouse, context: ReviewContext): Promise<void> {
    for (let round = 1; round <= MAX_CODE_REVIEW_ROUNDS; round++) {
        const review = await instance.prefix(`code-review-round-${round}`, async () => {
            const review = await reviewCode(agents, instance, context, round)
            if (hasActItems(review)) await fixReviewFindings(agents, context, review)
            return review
        })
        if (!needsAnotherReview(review)) break
    }
}

function hasActItems(review: FinalReview): boolean {
    return (review.act?.length ?? 0) > 0
}

function fixReviewFindings(
    agents: FactoryAgents,
    { worktree, requirements }: ReviewContext,
    review: FinalReview
): Promise<void> {
    return agents.fixer.run("fix-review-findings", {
        prompt: { file: prompt("fix"), vars: { requirements, actItems: review.act } },
        output: z.void(),
        worktree
    })
}

function needsAnotherReview(review: FinalReview): boolean {
    return hasActItems(review) && review.anotherReviewNeeded
}

async function reviewCode(
    agents: FactoryAgents,
    instance: ClankHouse,
    { worktree, requirements }: ReviewContext,
    round: number
): Promise<FinalReview> {
    const reviewPrompt = { file: prompt("review-code"), vars: { requirements } }
    const candidates = await allSucceeded([
        agents.codeReviewer1.run("review-code-1", {
            prompt: reviewPrompt,
            output: CandidateReview,
            worktree,
            snapshot: false
        }),
        agents.codeReviewer2.run("review-code-2", {
            prompt: reviewPrompt,
            output: CandidateReview,
            worktree,
            snapshot: false
        })
    ])
    const [review1, review2] = candidates.map(({ findings }) => formatItems("Findings", findings))
    await instance.artifacts.writeText(`code-review-${round}-1`, review1, "text/markdown")
    await instance.artifacts.writeText(`code-review-${round}-2`, review2, "text/markdown")

    const review = await agents.codeReviewSynthesizer.run("synthesize-code-review", {
        prompt: { file: prompt("synthesize-code-review"), vars: { requirements, review1, review2 } },
        output: FinalReview,
        worktree,
        snapshot: false
    })
    await instance.artifacts.writeText(`code-review-${round}`, formatFinalReview(review), "text/markdown")
    return review
}

function prompt(name: string): URL {
    return new URL(`prompts/${name}.md`, import.meta.url)
}

async function allSucceeded<T>(promises: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]> {
    const results = await Promise.allSettled(promises)
    return results.map((result) => {
        if (result.status === "rejected") throw result.reason
        return result.value
    })
}

function formatFinalReview({ act = [], skip }: FinalReview): string {
    return [formatItems("Act", act), formatItems("Skip", skip)].join("\n\n")
}

function formatItems(title: string, items: string[]): string {
    return [`## ${title}`, ...(items.length === 0 ? ["None."] : items.map((item) => `- ${item}`))].join("\n")
}
