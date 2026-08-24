import { Code, ConnectError } from "@connectrpc/connect"
import { formatZodError } from "@clankhouse/core/errors"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import * as z from "zod"
import { notFound, parseJson, required, toConnectError } from "./errors.js"
import type { ClankHouseServiceImplementation } from "./types.js"

type WorkflowHandlers = Pick<ClankHouseServiceImplementation, "listWorkflows" | "getWorkflow" | "startRun">

export function workflowHandlers(clankhouse: ClankHouse): WorkflowHandlers {
    return {
        listWorkflows() {
            return { workflows: clankhouse.workflows.list() }
        },
        getWorkflow(request) {
            required(request.name, "name")
            try {
                const workflow = clankhouse.workflows.get(request.name)
                return {
                    workflow: {
                        name: workflow.name,
                        ...(workflow.inputSchema !== undefined
                            ? { inputSchemaJson: JSON.stringify(workflow.inputSchema) }
                            : {}),
                        ...(workflow.outputSchema !== undefined
                            ? { outputSchemaJson: JSON.stringify(workflow.outputSchema) }
                            : {})
                    }
                }
            } catch (error) {
                throw toConnectError(error, {
                    workflow_not_registered: () => notFound("Workflow", request.name)
                })
            }
        },
        startRun(request) {
            required(request.workflowName, "workflow_name")
            try {
                return { runId: clankhouse.start(request.workflowName, parseJson(request.inputJson, "input_json")) }
            } catch (error) {
                if (error instanceof z.ZodError) {
                    throw new ConnectError(
                        `Workflow input is invalid: ${formatZodError(error)}`,
                        Code.InvalidArgument,
                        undefined,
                        undefined,
                        error
                    )
                }
                throw toConnectError(error, {
                    workflow_not_registered: () => notFound("Workflow", request.workflowName),
                    workflow_run_failed: Code.FailedPrecondition,
                    workflow_input_incompatible: Code.FailedPrecondition
                })
            }
        }
    }
}
