import {
    GetWorkflowResponseSchema,
    ListWorkflowsResponseSchema,
    type GetWorkflowResponse,
    type ListWorkflowsResponse
} from "@loopy/server/proto"
import type { Command } from "commander"
import { indent, prettyJson } from "../output"
import type { Runtime } from "../runtime"

export function registerWorkflows(program: Command, runtime: Runtime): void {
    const workflows = program.command("workflows").description("Inspect registered workflows")
    workflows
        .command("list")
        .description("List registered workflows")
        .action(async (_options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.listWorkflows({}, { signal: runtime.signal })
            await runtime.emit(command, ListWorkflowsResponseSchema, response, () => formatWorkflows(response))
        })
    workflows
        .command("get")
        .description("Get a workflow definition")
        .argument("<workflow-name>")
        .action(async (workflowName: string, _options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.getWorkflow({ name: workflowName }, { signal: runtime.signal })
            await runtime.emit(command, GetWorkflowResponseSchema, response, () => formatWorkflow(response))
        })
}

function formatWorkflows(response: ListWorkflowsResponse): string {
    if (response.workflows.length === 0) return "No workflows found.\n"
    return `${response.workflows.map((workflow) => workflow.name).join("\n")}\n`
}

function formatWorkflow(response: GetWorkflowResponse): string {
    const workflow = response.workflow
    if (workflow === undefined) return "Workflow response is empty.\n"
    const lines = [`Workflow: ${workflow.name}`]
    if (workflow.inputSchemaJson === undefined) {
        lines.push("", "Input: none")
    } else {
        lines.push("", "Input schema:", indent(prettyJson(workflow.inputSchemaJson)))
    }
    if (workflow.outputSchemaJson === undefined) {
        lines.push("", "Output: none")
    } else {
        lines.push("", "Output schema:", indent(prettyJson(workflow.outputSchemaJson)))
    }
    return `${lines.join("\n")}\n`
}
