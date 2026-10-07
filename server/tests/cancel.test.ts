import { create } from "@bufbuild/protobuf"
import { Code } from "@connectrpc/connect"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { setRunGcState } from "@clankhouse/core/db"
import { CancelRunResponseSchema, ExecutionStatus } from "@clankhouse/protocol"
import { tempClankHouse, testRun } from "@clankhouse/testing"
import { expect, test } from "vitest"
import * as z from "zod"
import { nextRunningStep, rpcClient, testServer } from "./helpers"

function registerWaiting(instance: ClankHouse): void {
    instance.registerWorkflow(
        "waiting",
        { input: z.null(), output: z.number(), key: () => "waiting" },
        async () => (await instance.waitFor({ key: "cancel-go", schema: z.object({ value: z.number() }) })).value
    )
}

test("cancelRun cancels an active run", async () => {
    // given a run waiting for an event
    const { clankhouse } = tempClankHouse()
    registerWaiting(clankhouse)
    const client = rpcClient(await testServer(clankhouse))
    const { runId } = await client.startRun({ workflowName: "waiting", inputJson: "null" })
    await nextRunningStep(client.watchRun({ runId })[Symbol.asyncIterator](), "wait:cancel-go")

    // when the run is canceled through the server
    const response = await client.cancelRun({ runId })

    // then the response is empty and the run becomes canceled
    expect(response).toEqual(create(CancelRunResponseSchema))
    expect((await client.getRun({ runId })).run?.metadata?.status).toBe(ExecutionStatus.CANCELED)
    // and the run is listed under the canceled status filter
    const listed = await client.listRuns({ statuses: [ExecutionStatus.CANCELED] })
    expect(listed.runs).toMatchObject([{ id: runId, status: ExecutionStatus.CANCELED }])
})

test("cancelRun cancels an interrupted run that is not executing", async () => {
    // given an interrupted run persisted by a closed server
    const { clankhouse, reopen } = tempClankHouse()
    registerWaiting(clankhouse)
    const firstServer = await testServer(clankhouse)
    const firstClient = rpcClient(firstServer)
    const { runId } = await firstClient.startRun({ workflowName: "waiting", inputJson: "null" })
    await nextRunningStep(firstClient.watchRun({ runId })[Symbol.asyncIterator](), "wait:cancel-go")
    await firstServer.close()
    const second = reopen()
    registerWaiting(second)
    const client = rpcClient(await testServer(second))
    expect((await client.getRun({ runId })).run?.metadata?.status).toBe(ExecutionStatus.INTERRUPTED)

    // when the inactive run is canceled
    await client.cancelRun({ runId })

    // then it becomes canceled
    expect((await client.getRun({ runId })).run?.metadata?.status).toBe(ExecutionStatus.CANCELED)
})

test("cancelRun is a no-op for an already canceled run", async () => {
    // given a canceled run
    const { clankhouse } = tempClankHouse()
    registerWaiting(clankhouse)
    const client = rpcClient(await testServer(clankhouse))
    const { runId } = await client.startRun({ workflowName: "waiting", inputJson: "null" })
    await nextRunningStep(client.watchRun({ runId })[Symbol.asyncIterator](), "wait:cancel-go")
    await client.cancelRun({ runId })
    const canceled = (await client.getRun({ runId })).run?.metadata

    // when it is canceled again
    const response = await client.cancelRun({ runId })

    // then the call succeeds and the run is unchanged
    expect(response).toEqual(create(CancelRunResponseSchema))
    expect((await client.getRun({ runId })).run?.metadata).toEqual(canceled)
})

test("cancelRun maps lifecycle and lookup failures to Connect codes", async () => {
    // given a succeeded run and a deleted run
    const { clankhouse } = tempClankHouse()
    await testRun(clankhouse, async () => null, { key: "succeeded" })
    const succeededId = (await clankhouse.runs.list({ key: "succeeded" }))[0]!.id
    await testRun(clankhouse, async () => null, { key: "deleted" })
    const deletedId = (await clankhouse.runs.list({ key: "deleted" }))[0]!.id
    setRunGcState(clankhouse.db, deletedId, "deleted")
    const client = rpcClient(await testServer(clankhouse))

    // when canceling a succeeded, missing, deleted run or omitting the run id
    // then each failure maps to its public Connect category
    await expect(client.cancelRun({ runId: succeededId })).rejects.toMatchObject({ code: Code.FailedPrecondition })
    await expect(client.cancelRun({ runId: "missing" })).rejects.toMatchObject({ code: Code.NotFound })
    await expect(client.cancelRun({ runId: deletedId })).rejects.toMatchObject({ code: Code.NotFound })
    await expect(client.cancelRun({})).rejects.toMatchObject({ code: Code.InvalidArgument })
})
