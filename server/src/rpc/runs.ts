import { Code, ConnectError } from "@connectrpc/connect"
import type { Loopy } from "@loopy/core/loopy"
import type { ListWorkflowOptions, ObservableRunStatus } from "@loopy/core/runs"
import { ExecutionStatus, type ListRunsRequest } from "../gen/loopy/server/v1/server_pb"
import { toRunMetadata, toStep, toWorkflowRun } from "../mappers"
import { notFound, required, toConnectError } from "./errors"
import type { LoopyServiceImplementation } from "./types"

type RunHandlers = Pick<LoopyServiceImplementation, "listRuns" | "getRun" | "watchRun" | "resumeRun" | "rerunRun">

export function runHandlers(loopy: Loopy): RunHandlers {
    return {
        async listRuns(request) {
            const options = listRunOptions(request)
            try {
                return { runs: (await loopy.runs.list(options)).map(toRunMetadata) }
            } catch (error) {
                throw toConnectError(error)
            }
        },
        async getRun(request) {
            required(request.runId, "run_id")
            try {
                return { run: toWorkflowRun(await loopy.runs.get(request.runId)) }
            } catch (error) {
                throw toConnectError(error, {
                    workflow_run_not_found: () => notFound("Workflow run", request.runId)
                })
            }
        },
        async *watchRun(request, context) {
            required(request.runId, "run_id")
            try {
                for await (const item of loopy.runs.stream(request.runId, {
                    ...(request.fromStepId !== undefined ? { fromStepId: request.fromStepId } : {}),
                    signal: context.signal
                })) {
                    if ("kind" in item) yield { item: { case: "step", value: toStep(item) } }
                    else yield { item: { case: "run", value: toRunMetadata(item) } }
                }
            } catch (error) {
                throw toConnectError(error, {
                    workflow_run_not_found: () => notFound("Workflow run", request.runId),
                    workflow_step_not_found: () =>
                        new ConnectError("from_step_id does not identify a step in the run", Code.InvalidArgument)
                })
            }
        },
        resumeRun(request) {
            required(request.runId, "run_id")
            try {
                return { runId: loopy.resume(request.runId) }
            } catch (error) {
                throw toConnectError(error, {
                    workflow_run_not_found: () => notFound("Workflow run", request.runId),
                    workflow_run_not_resumable: Code.FailedPrecondition,
                    workflow_run_not_latest: Code.FailedPrecondition,
                    workflow_not_registered: Code.FailedPrecondition
                })
            }
        },
        rerunRun(request) {
            required(request.runId, "run_id")
            required(request.fromStepKey, "from_step_key")
            try {
                return { runId: loopy.rerun(request.runId, { from: request.fromStepKey }) }
            } catch (error) {
                throw toConnectError(error, {
                    workflow_run_not_found: () => notFound("Workflow run", request.runId),
                    workflow_step_not_found: () =>
                        new ConnectError("from_step_key does not identify a step in the run", Code.InvalidArgument),
                    workflow_run_in_progress: Code.FailedPrecondition,
                    workflow_run_not_latest: Code.FailedPrecondition,
                    workflow_not_registered: Code.FailedPrecondition
                })
            }
        }
    }
}

function listRunOptions(request: ListRunsRequest): ListWorkflowOptions | undefined {
    if (request.limit === 0) throw new ConnectError("limit must be positive", Code.InvalidArgument)
    const statuses = request.statuses.map(fromExecutionStatus)
    const options: ListWorkflowOptions = {}
    if (request.workflowName !== undefined) options.workflowName = request.workflowName
    if (request.key !== undefined) options.key = request.key
    if (statuses.length > 0) options.statuses = statuses
    if (request.limit !== undefined) options.lastN = request.limit
    return Object.keys(options).length === 0 ? undefined : options
}

function fromExecutionStatus(status: ExecutionStatus): ObservableRunStatus {
    switch (status) {
        case ExecutionStatus.INTERRUPTED:
            return "interrupted"
        case ExecutionStatus.RUNNING:
            return "running"
        case ExecutionStatus.SUCCEEDED:
            return "succeeded"
        case ExecutionStatus.FAILED:
            return "failed"
        default:
            throw new ConnectError("statuses contains an unspecified value", Code.InvalidArgument)
    }
}
