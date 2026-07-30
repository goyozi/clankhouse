import type { MessageInitShape } from "@bufbuild/protobuf"
import { timestampFromDate } from "@bufbuild/protobuf/wkt"
import type { Artifact as CoreArtifact } from "@loopy/core/artifacts"
import type { AISession, AISessionMessage } from "@loopy/core/ai/sessions"
import type {
    ObservableRunStatus,
    ObservableStepStatus,
    Step as CoreStep,
    WorkflowRun as CoreWorkflowRun,
    WorkflowRunMetadata as CoreRunMetadata
} from "@loopy/core/runs"
import {
    ArtifactKind,
    ArtifactSchema,
    ExecutionStatus,
    RunMetadataSchema,
    SessionKind,
    SessionMessageSchema,
    SessionRole,
    SessionSchema,
    StepKind,
    StepSchema,
    WorkflowRunSchema
} from "./gen/loopy/server/v1/server_pb"

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
        provider: session.provider,
        model: session.model,
        status: toExecutionStatus(session.status),
        startedAt: timestampFromDate(session.startedAt),
        ...(session.endedAt !== undefined ? { endedAt: timestampFromDate(session.endedAt) } : {}),
        messages: session.messages.map(toSessionMessage)
    }
}

export function toSessionMessage(message: AISessionMessage): MessageInitShape<typeof SessionMessageSchema> {
    return {
        id: message.id,
        sessionId: message.sessionId,
        role: toSessionRole(message.role),
        content: message.content,
        createdAt: timestampFromDate(message.createdAt)
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
    }
}

function toSessionRole(role: AISessionMessage["role"]): SessionRole {
    switch (role) {
        case "system":
            return SessionRole.SYSTEM
        case "user":
            return SessionRole.USER
        case "assistant":
            return SessionRole.ASSISTANT
        case "reasoning":
            return SessionRole.REASONING
        case "tool":
            return SessionRole.TOOL
        case "tool_result":
            return SessionRole.TOOL_RESULT
    }
}
