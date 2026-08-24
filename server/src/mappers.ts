import type { MessageInitShape } from "@bufbuild/protobuf"
import { timestampFromDate } from "@bufbuild/protobuf/wkt"
import type { Artifact as CoreArtifact } from "@clankhouse/core/artifacts"
import type {
    AISession,
    AISessionMessage,
    CommonTool as CoreCommonTool,
    SessionMessageRole,
    ToolSource
} from "@clankhouse/core/ai/sessions"
import type {
    ObservableRunStatus,
    ObservableStepStatus,
    Step as CoreStep,
    WorkflowRun as CoreWorkflowRun,
    WorkflowRunMetadata as CoreRunMetadata
} from "@clankhouse/core/runs"
import {
    ArtifactKind,
    ArtifactSchema,
    ExecutionStatus,
    RunMetadataSchema,
    SessionMessageSchema,
    SessionKind,
    SessionRole,
    SessionSchema,
    SessionToolCallSchema,
    StepKind,
    StepSchema,
    ToolResultStatus,
    ToolSourceKind,
    WorkflowRunSchema
} from "@clankhouse/protocol"

export function toRunMetadata(row: CoreRunMetadata): MessageInitShape<typeof RunMetadataSchema> {
    return {
        id: row.id,
        key: row.key,
        attempt: row.attempt,
        workflowName: row.workflowName,
        startedAt: timestampFromDate(row.startedAt),
        ...(row.endedAt !== undefined ? { endedAt: timestampFromDate(row.endedAt) } : {}),
        status: toExecutionStatus(row.status)
    }
}

export function toWorkflowRun(run: CoreWorkflowRun): MessageInitShape<typeof WorkflowRunSchema> {
    return {
        metadata: toRunMetadata(run),
        ...(run.outputJson !== undefined ? { outputJson: run.outputJson } : {}),
        ...(run.error !== undefined ? { error: run.error } : {}),
        ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
        steps: run.steps.map(toStep),
        artifacts: run.artifacts.map(toArtifact)
    }
}

export function toStep(step: CoreStep): MessageInitShape<typeof StepSchema> {
    const base = {
        id: step.id,
        runId: step.runId,
        key: step.key,
        name: step.name,
        seq: step.seq,
        kind: toStepKind(step.kind),
        status: toExecutionStatus(step.status),
        startedAt: timestampFromDate(step.startedAt),
        ...(step.endedAt !== undefined ? { endedAt: timestampFromDate(step.endedAt) } : {}),
        ...(step.error !== undefined ? { error: step.error } : {}),
        ...(step.errorCode !== undefined ? { errorCode: step.errorCode } : {}),
        ...(step.outputJson !== undefined ? { outputJson: step.outputJson } : {})
    }
    switch (step.kind) {
        case "custom":
            return base
        case "artifact":
            return { ...base, ...(step.artifactId !== undefined ? { artifactId: step.artifactId } : {}) }
        case "llm":
            return { ...base, ...(step.sessionId !== undefined ? { sessionId: step.sessionId } : {}) }
        case "agent":
            return {
                ...base,
                ...(step.sessionId !== undefined ? { sessionId: step.sessionId } : {}),
                ...(step.snapshotRef !== undefined ? { snapshotRef: step.snapshotRef } : {})
            }
        case "event":
            return { ...base, ...(step.eventKey !== undefined ? { eventKey: step.eventKey } : {}) }
        case "worktree":
            return base
    }
}

function toStepKind(kind: CoreStep["kind"]): StepKind {
    switch (kind) {
        case "custom":
            return StepKind.CUSTOM
        case "artifact":
            return StepKind.ARTIFACT
        case "llm":
            return StepKind.LLM
        case "agent":
            return StepKind.AGENT
        case "event":
            return StepKind.EVENT
        case "worktree":
            return StepKind.WORKTREE
    }
}

export function toArtifact(artifact: CoreArtifact): MessageInitShape<typeof ArtifactSchema> {
    return {
        id: artifact.id,
        runId: artifact.runId,
        name: artifact.name,
        file: artifact.file,
        kind: artifact.kind === "text" ? ArtifactKind.TEXT : ArtifactKind.BINARY,
        ...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {})
    }
}

export function toSession(session: AISession): MessageInitShape<typeof SessionSchema> {
    return {
        id: session.id,
        kind: session.kind === "llm" ? SessionKind.LLM : SessionKind.CODING_AGENT,
        client: session.client,
        provider: session.provider,
        model: session.model,
        status: toExecutionStatus(session.status),
        startedAt: timestampFromDate(session.startedAt),
        ...(session.endedAt !== undefined ? { endedAt: timestampFromDate(session.endedAt) } : {}),
        messages: session.messages.map(toSessionMessage)
    }
}

function toExecutionStatus(status: ObservableRunStatus | ObservableStepStatus): ExecutionStatus {
    switch (status) {
        case "interrupted":
            return ExecutionStatus.INTERRUPTED
        case "running":
            return ExecutionStatus.RUNNING
        case "succeeded":
            return ExecutionStatus.SUCCEEDED
        case "failed":
            return ExecutionStatus.FAILED
    }
}

export function toSessionMessage(message: AISessionMessage): MessageInitShape<typeof SessionMessageSchema> {
    const base = {
        id: message.id,
        sessionId: message.sessionId,
        createdAt: timestampFromDate(message.createdAt)
    }
    switch (message.type) {
        case "message":
            return {
                ...base,
                payload: { case: "message", value: { role: toSessionRole(message.role), content: message.content } }
            }
        case "tool_call":
            return {
                ...base,
                payload: {
                    case: "toolCall",
                    value: {
                        id: message.toolCall.id,
                        name: message.toolCall.name,
                        source: toToolSource(message.toolCall.source),
                        inputJson: JSON.stringify(message.toolCall.input),
                        common: toCommonTool(message.toolCall.common)
                    }
                }
            }
        case "tool_result":
            return {
                ...base,
                payload: {
                    case: "toolResult",
                    value: {
                        toolCallId: message.toolResult.toolCallId,
                        status:
                            message.toolResult.status === "succeeded"
                                ? ToolResultStatus.SUCCEEDED
                                : ToolResultStatus.FAILED,
                        ...(message.toolResult.output !== undefined
                            ? { outputJson: JSON.stringify(message.toolResult.output) }
                            : {}),
                        ...(message.toolResult.error !== undefined ? { error: message.toolResult.error } : {})
                    }
                }
            }
    }
}

function toSessionRole(role: SessionMessageRole): SessionRole {
    switch (role) {
        case "system":
            return SessionRole.SYSTEM
        case "user":
            return SessionRole.USER
        case "assistant":
            return SessionRole.ASSISTANT
        case "reasoning":
            return SessionRole.REASONING
    }
}

function toToolSource(source: ToolSource): { kind: ToolSourceKind; server?: string } {
    switch (source.kind) {
        case "native":
            return { kind: ToolSourceKind.NATIVE }
        case "provider":
            return { kind: ToolSourceKind.PROVIDER }
        case "mcp":
            return { kind: ToolSourceKind.MCP, server: source.server }
    }
}

function toCommonTool(common: CoreCommonTool | undefined): MessageInitShape<typeof SessionToolCallSchema>["common"] {
    switch (common?.name) {
        case "file.read":
            return { case: "fileRead" as const, value: { path: common.path } }
        case "file.change":
            return { case: "fileChange" as const, value: { paths: common.paths } }
        case "shell.execute":
            return { case: "shellExecute" as const, value: { command: common.command } }
        case "file.search":
            return {
                case: "fileSearch" as const,
                value: {
                    ...(common.pattern !== undefined ? { pattern: common.pattern } : {}),
                    ...(common.path !== undefined ? { path: common.path } : {})
                }
            }
        case "web.search":
            return { case: "webSearch" as const, value: { query: common.query } }
        case undefined:
            return { case: undefined }
    }
}
