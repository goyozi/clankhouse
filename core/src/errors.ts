import type * as z from "zod"

export type LoopyErrorCode =
    | "workflow_already_registered"
    | "workflow_not_registered"
    | "workflow_input_incompatible"
    | "schema_not_json_compatible"
    | "workflow_run_not_found"
    | "workflow_run_failed"
    | "workflow_run_not_resumable"
    | "workflow_run_in_progress"
    | "workflow_run_not_latest"
    | "workflow_step_not_found"
    | "workflow_step_duplicate"
    | "workflow_context_required"
    | "event_definitions_empty"
    | "event_schema_validation_failed"
    | "event_wait_already_registered"
    | "event_payload_required"
    | "artifact_not_found"
    | "ai_session_not_found"
    | "ai_session_message_not_found"
    | "coding_agent_snapshot_missing"
    | "ai_output_missing"
    | "ai_output_invalid"
    | "llm_response_incomplete"
    | "llm_response_failed"
    | "llm_response_invalid"
    | "fake_agent_edit_text_not_found"
    | "git_snapshot_name_invalid"

export class LoopyError extends Error {
    readonly code: LoopyErrorCode

    constructor(code: LoopyErrorCode, message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = "LoopyError"
        this.code = code
    }
}

export function formatZodError(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.join(".")
            return path.length === 0 ? issue.message : `${path}: ${issue.message}`
        })
        .join("; ")
}
