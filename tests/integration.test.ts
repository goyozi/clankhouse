import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod";
import { expect, test } from "vitest";
import { FakeCodingAgent } from "../core/ai/fake-agent";
import { FakeLLM } from "../core/ai/fake-llm";
import { GitRepository } from "../core/git";
import { Loopy } from "../core/loopy";
import { uniqueName } from "../core/util";
import { gate, tempGitRepo, tempLoopy } from "./helpers";

test("end-to-end: durable workflow with llm, agent, artifact and approval survives crashes and reruns", async () => {
    // given a durable loopy instance and a git repository
    const { loopy, dir, reopen } = tempLoopy();
    const repo = await tempGitRepo();
    const repository = new GitRepository(repo.path);

    // and fake llm and agent that record call counts and produce deterministic outputs
    const calls = { plan: 0, llm: 0, agent: 0, publish: 0 };
    const llm = new FakeLLM((_stepName, prompt) => {
        calls.llm++;
        return { content: `content of ${prompt}` };
    });
    const agent = new FakeCodingAgent((_stepName, prompt) => {
        calls.agent++;
        const drafts = JSON.parse(prompt) as { file: string, content: string }[];
        return {
            changes: drafts.map(d => ({ file: `${d.file}.txt`, text: d.content })),
            output: { written: drafts.length }
        };
    });

    // and a workflow body that plans, drafts via llm, implements via agent, publishes an artifact and waits for approval
    type Hooks = { afterDrafts?: () => Promise<void>, afterApproval?: () => Promise<void> };
    const makeBody = (l: Loopy, hooks: Hooks) => async () => {
        const files = await l.step("plan", z.array(z.string()), async () => {
            calls.plan++;
            return ["alpha", "beta"];
        });
        const drafts: { file: string, content: string }[] = [];
        for (const file of files) {
            await l.prefix(`draft-${file}`, async () => {
                const draft = await llm.call("draft", { prompt: file, output: z.object({ content: z.string() }) });
                drafts.push({ file, content: draft.content });
            });
        }
        if (hooks.afterDrafts) await hooks.afterDrafts();
        const worktree = await repository.worktree({ base: "main" });
        await agent.run("implement", { prompt: JSON.stringify(drafts), output: z.object({ written: z.number() }), worktree });
        await l.artifacts.writeText("summary", `implemented ${files.join(", ")}`, "text/plain");
        const approval = await l.waitFor("approval", z.object({ approvedBy: z.string() }));
        if (hooks.afterApproval) await hooks.afterApproval();
        return l.step("publish", z.string(), async () => {
            calls.publish++;
            return `published by ${approval.approvedBy}`;
        });
    };

    // given gates to pause the run after the drafts phase
    const parkA = gate();
    const reachedA = gate();
    // when the first run starts
    loopy.run("feature", "feat-x", makeBody(loopy, {
        afterDrafts: async () => {
            reachedA.release();
            await parkA.released;
        }
    })).catch(() => { });
    // and it pauses right after drafting, before implementing
    await reachedA.released;
    // then only the plan step and the two draft llm calls have run so far
    expect(calls).toEqual({ plan: 1, llm: 2, agent: 0, publish: 0 });

    // given the loopy instance is reopened, simulating a crash and restart
    const second = reopen();
    // and gates to pause the run after approval is granted
    const parkB = gate();
    const reachedB = gate();
    // when the run resumes and reaches the waitFor approval step
    second.run("feature", "feat-x", makeBody(second, {
        afterApproval: async () => {
            reachedB.release();
            await parkB.released;
        }
    })).catch(() => { });
    // then the run is parked with a single pending wait-for-approval step
    await expect.poll(
        () => second.db.prepare("SELECT COUNT(*) AS n FROM steps WHERE key = 'wait:approval'").get(),
        { timeout: 10_000 }
    ).toEqual({ n: 1 });
    // when the approval event is emitted
    await second.emit("approval", { approvedBy: "greg" });
    // and the run resumes past approval and pauses again afterward
    await reachedB.released;
    // then the agent implement step has run but publish has not yet
    expect(calls).toEqual({ plan: 1, llm: 2, agent: 1, publish: 0 });

    // given the loopy instance is reopened again
    const third = reopen();
    // when the run resumes to completion without further pausing
    const result = await third.run("feature", "feat-x", makeBody(third, {}));
    // then it returns the published result
    expect(result).toBe("published by greg");
    // and all steps including publish have each run exactly once
    expect(calls).toEqual({ plan: 1, llm: 2, agent: 1, publish: 1 });
    // and exactly one event was recorded across the whole run
    expect(third.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });

    // then the agent-implemented files are written to the worktree
    const worktreePath = path.join(dir, "worktrees", uniqueName(repo.path), uniqueName("feature/feat-x"));
    expect(fs.readFileSync(path.join(worktreePath, "alpha.txt"), "utf8")).toBe("content of alpha");
    // and the second drafted file is also present
    expect(fs.readFileSync(path.join(worktreePath, "beta.txt"), "utf8")).toBe("content of beta");

    // then the run record reflects a single succeeded attempt with the published output
    const runs = await third.runs.list({ key: "feat-x" });
    expect(runs).toHaveLength(1);
    const run = await third.runs.get(runs[0].id);
    expect(run.status).toBe("succeeded");
    expect(run.attempt).toBe(1);
    expect(run.output).toBe("published by greg");
    // and the steps are recorded in the expected order, kind and status
    expect(run.steps.map(s => [s.key, s.kind, s.status])).toEqual([
        ["plan", "custom", "succeeded"],
        ["draft-alpha/draft", "llm", "succeeded"],
        ["draft-beta/draft", "llm", "succeeded"],
        ["implement", "agent", "succeeded"],
        ["artifact:summary", "artifact", "succeeded"],
        ["wait:approval", "event", "succeeded"],
        ["publish", "custom", "succeeded"]
    ]);
    // and the summary artifact is recorded with the expected text
    expect(run.artifacts).toHaveLength(1);
    expect(await third.artifacts.readText(run.artifacts[0].id)).toEqual({
        text: "implemented alpha, beta",
        mimeType: "text/plain"
    });
    // and three ai sessions were recorded, one per llm draft plus one for the agent
    expect(third.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 3 });

    // given the alpha.txt file is deleted from the worktree
    fs.rmSync(path.join(worktreePath, "alpha.txt"));
    // when the workflow is rerun from the publish step
    const rerunResult = await third.run("feature", "feat-x", makeBody(third, {}), { from: "publish" });
    // then it returns the same published result
    expect(rerunResult).toBe("published by greg");
    // and only the publish step runs again, all earlier steps are not re-executed
    expect(calls).toEqual({ plan: 1, llm: 2, agent: 1, publish: 2 });
    // and the deleted file reappears, restored from the implement step's snapshot
    expect(fs.readFileSync(path.join(worktreePath, "alpha.txt"), "utf8")).toBe("content of alpha");
    // and two attempts are now recorded for the same run key, both succeeded
    const attempts = await third.runs.list({ key: "feat-x" });
    expect(attempts.map(a => [a.attempt, a.status]).sort()).toEqual([[1, "succeeded"], [2, "succeeded"]]);
    // and the second attempt has all 7 steps recorded as succeeded
    const attempt2 = await third.runs.get(attempts.find(a => a.attempt === 2)!.id);
    expect(attempt2.steps).toHaveLength(7);
    expect(attempt2.steps.every(s => s.status === "succeeded")).toBe(true);
});
