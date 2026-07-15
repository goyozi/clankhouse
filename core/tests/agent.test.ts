import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"
import { expect, test } from "vitest"
import { FakeCodingAgent } from "@loopy/core/ai/fake-agent"
import { GitRepository, Worktree } from "@loopy/core/git"
import { uniqueName } from "@loopy/core/util"
import { runGit, runOutput, tempGitRepo, tempLoopy, testRun } from "@loopy/test-utils"

const outputSchema = z.object({ done: z.boolean() })
const workflowOptions = { input: z.void(), output: z.any(), key: () => "test-key" }

test("FakeCodingAgent applies changes and snapshots the worktree", async () => {
    // given a fake coding agent that edits two files and returns a typed output
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const agent = new FakeCodingAgent(() => ({
        changes: [
            { file: "src/hello.ts", text: "export const hi = 1\n" },
            { file: "README.md", oldText: "# test", newText: "# tested" }
        ],
        output: { done: true }
    }))
    let worktree!: Worktree

    // when the agent runs inside a durable step
    const result = await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then it returns the agent's output
    expect(result).toEqual({ done: true })
    // and the file changes are applied to the worktree
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
    expect(fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")).toBe("# tested\n")
    // and the run records an agent step with a snapshot ref
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.kind).toBe("agent")
    if (step.kind !== "agent") throw new Error("unreachable")
    expect(step.snapshotRef).toBe(
        `refs/loopy/agent/${uniqueName("test-workflow/test-key")}/1/${uniqueName("implement")}`
    )
    expect((await worktree.git(["rev-parse", step.snapshotRef!])).exitCode).toBe(0)
    // and the session records the conversation and succeeds
    const session = await loopy.sessions.get(step.sessionId!)
    expect(session.kind).toBe("coding-agent")
    expect(session.status).toBe("succeeded")
    expect(session.messages.map((m) => m.role)).toEqual(["user", "tool", "tool", "assistant"])
    // and the final assistant message carries the agent's output
    expect(session.messages.at(-1)!.content).toBe(JSON.stringify({ done: true }))
})

test("agent step replay restores the worktree snapshot", async () => {
    // given a fake coding agent that counts invocations and edits one file
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    let invocations = 0
    const agent = new FakeCodingAgent(() => {
        invocations++
        return {
            changes: [{ file: "src/hello.ts", text: "export const hi = 1\n" }],
            output: { done: true }
        }
    })
    // and a publish step that initially fails
    let publishImpl: () => string = () => {
        throw new Error("boom")
    }
    let worktree!: Worktree
    const body = async () => {
        worktree = await repository.worktree({ base: "main" })
        await agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        return loopy.step("publish", z.string(), async () => publishImpl())
    }
    loopy.registerWorkflow("test-workflow", workflowOptions, body)

    // when the workflow runs and the publish step throws
    const firstId = loopy.start("test-workflow", undefined)
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")

    // then discarding the worktree's uncommitted changes removes the agent's edit
    await runGit(worktree.path, ["reset", "--hard"])
    await runGit(worktree.path, ["clean", "-fd"])
    expect(fs.existsSync(path.join(worktree.path, "src/hello.ts"))).toBe(false)

    // and when the workflow reruns from the publish step with a working implementation
    publishImpl = () => "published"
    const secondId = loopy.rerun(firstId, { from: "publish" })
    expect(await runOutput(loopy, secondId)).toBe("published")

    // then the agent step is not re-invoked on replay
    expect(invocations).toBe(1)
    // and the worktree snapshot from the earlier agent step is restored
    expect(fs.readFileSync(path.join(worktree.path, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")
})

test("agent step replay fails loudly when its worktree snapshot is missing", async () => {
    // given an agent step that succeeds and a later publish step that initially fails
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const agent = new FakeCodingAgent(() => ({
        changes: [{ file: "src/hello.ts", text: "export const hi = 1\n" }],
        output: { done: true }
    }))
    let publishImpl: () => string = () => {
        throw new Error("boom")
    }
    const body = async () => {
        const worktree = await repository.worktree({ base: "main" })
        await agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        return loopy.step("publish", z.string(), async () => publishImpl())
    }
    loopy.registerWorkflow("test-workflow", workflowOptions, body)

    // when the workflow runs and the publish step throws
    const firstId = loopy.start("test-workflow", undefined)
    await expect(runOutput(loopy, firstId)).rejects.toThrow("boom")
    // and the agent step's snapshot ref is lost before replay (e.g. the ref was pruned)
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    loopy.db.prepare("UPDATE steps SET snapshot_ref = NULL WHERE id = ?").run(run.steps[0].id)

    // and when the workflow reruns from the publish step
    publishImpl = () => "published"
    // then replaying the agent step refuses to proceed rather than silently skipping the restore
    const secondId = loopy.rerun(firstId, { from: "publish" })
    await expect(runOutput(loopy, secondId)).rejects.toThrow(/no worktree snapshot/)
})

test("snapshot refs stay distinct for step keys that sanitize to the same string", async () => {
    // given two agent steps whose keys sanitize to the same string ("a-b" vs prefix "a" with key "b")
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const agent = new FakeCodingAgent(() => ({ changes: [], output: { done: true } }))

    // when both agent steps run within the same workflow
    await testRun(loopy, async () => {
        const worktree = await repository.worktree({ base: "main" })
        await agent.run("a-b", { prompt: "do it", output: outputSchema, worktree })
        await loopy.prefix("a", () => agent.run("b", { prompt: "do it", output: outputSchema, worktree }))
        return null
    })

    // then both agent steps are recorded on the run
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const refs = run.steps.map((s) => (s.kind === "agent" ? s.snapshotRef : undefined))
    expect(refs).toHaveLength(2)
    // and their snapshot refs are distinct
    expect(new Set(refs).size).toBe(2)
})

test("edit writes replacement-pattern characters literally", async () => {
    // given a fake coding agent whose edit replaces text with regex-replacement-pattern characters
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const agent = new FakeCodingAgent(() => ({
        changes: [{ file: "README.md", oldText: "# test", newText: "echo $& $' $` $$1" }],
        output: { done: true }
    }))
    let worktree!: Worktree

    // when the agent runs the edit
    await testRun(loopy, async () => {
        worktree = await repository.worktree({ base: "main" })
        return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
    })

    // then the special characters are written to the file literally
    expect(fs.readFileSync(path.join(worktree.path, "README.md"), "utf8")).toBe("echo $& $' $` $$1\n")
})

test("edit with missing oldText fails the step and the session", async () => {
    // given a fake coding agent whose edit references oldText that is not in the file
    const { loopy } = tempLoopy()
    const repo = await tempGitRepo()
    const repository = new GitRepository(repo.path)
    const agent = new FakeCodingAgent(() => ({
        changes: [{ file: "README.md", oldText: "not there", newText: "x" }],
        output: { done: true }
    }))

    // when the agent runs the edit
    await expect(
        testRun(loopy, async () => {
            const worktree = await repository.worktree({ base: "main" })
            return agent.run("implement", { prompt: "do it", output: outputSchema, worktree })
        })
    ).rejects.toThrow(/oldText not found/)

    // then the agent step is marked failed
    const run = await loopy.runs.get((await loopy.runs.list())[0].id)
    const step = run.steps[0]
    expect(step.status).toBe("failed")
    if (step.kind !== "agent") throw new Error("unreachable")
    // and the session is marked failed
    expect((await loopy.sessions.get(step.sessionId!)).status).toBe("failed")
})
