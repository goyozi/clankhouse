import * as z from "zod";
import { expect, test } from "vitest";
import { gate, tempLoopy } from "./helpers";

const input = z.object({ id: z.string(), value: z.number() });
const output = z.object({ doubled: z.number() });
const options = { input, output, key: (i: z.infer<typeof input>) => `double-${i.id}` };

test("start runs a registered workflow to completion", async () => {
    // given a loopy instance with a registered "double" workflow
    const { loopy } = tempLoopy();
    loopy.registerWorkflow("double", options, async (i) => {
        const doubled = await loopy.step("compute", z.number(), async () => i.value * 2);
        return { doubled };
    });

    // when starting the workflow
    await loopy.start("double", { id: "x", value: 21 });

    // then the run succeeds
    await expect.poll(async () => (await loopy.runs.list())[0]?.status).toBe("succeeded");
    // and the run metadata records the key and workflow name
    const [meta] = await loopy.runs.list();
    expect(meta.key).toBe("double-x");
    expect(meta.workflowName).toBe("double");
    // and the run output is the doubled value
    const run = await loopy.runs.get(meta.id);
    expect(run.output).toEqual({ doubled: 42 });
});

test("start validates input against the input schema", async () => {
    // given a loopy instance with a registered "double" workflow
    const { loopy } = tempLoopy();
    loopy.registerWorkflow("double", options, async () => ({ doubled: 0 }));

    // when starting with an input that fails the input schema
    // then it rejects
    await expect(loopy.start("double", { id: "x", value: "nope" })).rejects.toThrow();
    // and no run is recorded
    expect(await loopy.runs.list()).toHaveLength(0);
});

test("start resolves before the run finishes", async () => {
    // given a workflow that parks on a gate before completing
    const { loopy } = tempLoopy();
    const parked = gate();
    loopy.registerWorkflow("double", options, async (i) => {
        await parked.released;
        return { doubled: i.value * 2 };
    });

    // when starting the workflow
    await loopy.start("double", { id: "x", value: 1 });

    // then the run is still running
    const [meta] = await loopy.runs.list();
    expect(meta.status).toBe("running");

    // when the gate is released
    parked.release();

    // then the run succeeds
    await expect.poll(async () => (await loopy.runs.list())[0]?.status).toBe("succeeded");
});

test("start is a no-op while the run is active", async () => {
    // given a workflow that parks on a gate before completing
    const { loopy } = tempLoopy();
    const parked = gate();
    loopy.registerWorkflow("double", options, async (i) => {
        await parked.released;
        return { doubled: i.value * 2 };
    });

    // when starting the same workflow key twice while the first run is active
    await loopy.start("double", { id: "x", value: 1 });
    await loopy.start("double", { id: "x", value: 1 });

    // then only one run is recorded
    expect(await loopy.runs.list()).toHaveLength(1);

    // when the gate is released
    parked.release();

    // then the run succeeds
    await expect.poll(async () => (await loopy.runs.list())[0]?.status).toBe("succeeded");
});

test("workflow output is validated against the output schema", async () => {
    // given a workflow that returns an output violating the output schema
    const { loopy } = tempLoopy();
    loopy.registerWorkflow("double", options, async () => ({ doubled: "nope" }) as any);

    // when starting the workflow
    await loopy.start("double", { id: "x", value: 1 });

    // then the run fails
    await expect.poll(async () => (await loopy.runs.list())[0]?.status).toBe("failed");
    // and the run records an error
    const run = await loopy.runs.get((await loopy.runs.list())[0].id);
    expect(run.error).toBeDefined();
});

test("start of an unregistered workflow is rejected", async () => {
    // given a loopy instance with no workflows registered
    const { loopy } = tempLoopy();

    // when starting a workflow name that was never registered
    // then it rejects with a "not registered" error
    await expect(loopy.start("missing", {})).rejects.toThrow(/not registered/);
});

test("duplicate workflow registration throws", () => {
    // given a loopy instance with the "double" workflow already registered
    const { loopy } = tempLoopy();
    loopy.registerWorkflow("double", options, async () => ({ doubled: 0 }));

    // when registering a workflow with the same name again
    // then it throws an "already registered" error
    expect(() => loopy.registerWorkflow("double", options, async () => ({ doubled: 0 }))).toThrow(/already registered/);
});
