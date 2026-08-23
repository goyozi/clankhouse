import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { CodingAgent } from "@loopy/core/ai/coding-agent"
import { GitRepository } from "@loopy/core/git"
import * as z from "zod"

const execFileAsync = promisify(execFile)

const reviewPrompt = `Please review my uncommitted changes

Note: Only the tagged answer is read — nothing else you produce is passed on. Even if you report
findings through a tool (\`ReportFindings\` or anything similar), you must still write every
one of them out in full in the provided answer tags. Do not replace them with a pointer to the tool
output, a count, or a summary.`
const synthesisPrompt = "Verify and de-duplicate the findings, and combine them into a final prioritized Act/Skip list"

export type DualReviewAgents = {
    reviewer1: CodingAgent
    reviewer2: CodingAgent
    synthesizer: CodingAgent
}

export type DualReviewInput = {
    repositoryPath: string
}

export function createDualReviewWorkflow({
    reviewer1,
    reviewer2,
    synthesizer
}: DualReviewAgents): (input: DualReviewInput) => Promise<string> {
    return async ({ repositoryPath }) => {
        const repository = new GitRepository(await repositoryRoot(repositoryPath))
        const worktree = await repository.worktree({ includeUncommitted: true })
        const [reviewer1Findings, reviewer2Findings] = await allSucceeded([
            reviewer1.run("review-with-reviewer1", {
                prompt: reviewPrompt,
                output: z.string(),
                worktree,
                snapshot: false
            }),
            reviewer2.run("review-with-reviewer2", {
                prompt: reviewPrompt,
                output: z.string(),
                worktree,
                snapshot: false
            })
        ])

        const result = await synthesizer.run("synthesize-reviews", {
            prompt: `${synthesisPrompt}

Reviewer1 findings:
<reviewer1-findings>
${reviewer1Findings}
</reviewer1-findings>

Reviewer2 findings:
<reviewer2-findings>
${reviewer2Findings}
</reviewer2-findings>`,
            output: z.string(),
            worktree,
            snapshot: false
        })
        return result.replaceAll(worktree.path, () => repository.path)
    }
}

async function repositoryRoot(directory: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: directory })
    return stdout.trim()
}

async function allSucceeded<T>(promises: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]> {
    const results = await Promise.allSettled(promises)
    return results.map((result) => {
        if (result.status === "rejected") throw result.reason
        return result.value
    })
}
