import { toJsonString } from "@bufbuild/protobuf"
import {
    ExecutionStatus,
    GetRunResponseSchema,
    GetSessionResponseSchema,
    ListRunsResponseSchema,
    RerunRunResponseSchema,
    ResumeRunResponseSchema,
    StartRunResponseSchema,
    StepKind,
    StepSchema,
    WatchRunResponseSchema,
    WatchSessionResponseSchema,
    type GetRunResponse,
    type GetSessionResponse,
    type ListRunsResponse,
    type RunMetadata,
    type Session,
    type Step,
    type WatchRunResponse,
    type WatchSessionResponse,
    type WorkflowRun
} from "@loopy/server/proto"
import { InvalidArgumentError, type Command } from "commander"
import type { LoopyClient } from "../client"
import { readJsonInput } from "../io"
import { executionStatus, indent, type Output, prettyJson, table, timestamp } from "../output"
import type { Runtime } from "../runtime"
import { formatArtifactValue } from "./artifacts"
import { formatSessionMessage, formatSessionValue } from "./sessions"

type RunGetOptions = {
    include?: "sessions"
    watch?: boolean
}

type RunWatchItem =
    | { kind: "run"; schema: typeof WatchRunResponseSchema; message: WatchRunResponse }
    | { kind: "session"; schema: typeof WatchSessionResponseSchema; message: WatchSessionResponse }
    | { kind: "session-error"; sessionId: string; error: unknown }

type RunWatchOptions = {
    runId: string
    fromStepId?: string
    includeSessions: boolean
    signal: AbortSignal
    knownSteps?: ReadonlyMap<string, string>
    sessionCursors?: ReadonlyMap<string, string | undefined>
}

export function registerRuns(program: Command, runtime: Runtime): void {
    const runs = program.command("runs").description("Start and inspect workflow runs")
    runs.command("start")
        .description("Start a workflow run")
        .argument("<workflow-name>")
        .requiredOption("--input <file|->", "JSON input file, or - for stdin")
        .action(async (workflowName: string, options: { input: string }, command: Command) => {
            const inputJson = await readJsonInput(options.input, runtime.cwd, runtime.stdin, runtime.signal)
            const client = await runtime.client(command)
            const response = await client.startRun({ workflowName, inputJson }, { signal: runtime.signal })
            await runtime.emit(command, StartRunResponseSchema, response, () => `${response.runId}\n`)
        })
    runs.command("list")
        .description("List workflow runs")
        .option("--workflow <name>", "filter by workflow")
        .option("--key <key>", "filter by run key")
        .option("--status <status>", "filter by status", collectStatus, [])
        .option("--limit <n>", "limit the number of runs", positiveInteger)
        .action(
            async (
                options: {
                    workflow?: string
                    key?: string
                    status: ExecutionStatus[]
                    limit?: number
                },
                command: Command
            ) => {
                const client = await runtime.client(command)
                const response = await client.listRuns(
                    {
                        ...(options.workflow !== undefined ? { workflowName: options.workflow } : {}),
                        ...(options.key !== undefined ? { key: options.key } : {}),
                        statuses: options.status,
                        ...(options.limit !== undefined ? { limit: options.limit } : {})
                    },
                    { signal: runtime.signal }
                )
                await runtime.emit(command, ListRunsResponseSchema, response, () => formatRuns(response))
            }
        )
    runs.command("get")
        .description("Get a workflow run")
        .argument("<run-id>")
        .option("--include <resource>", "include related sessions", includeResource)
        .option("--watch", "watch later run updates")
        .action(async (runId: string, options: RunGetOptions, command: Command) => {
            await getRun(runtime, command, runId, options)
        })
    runs.command("watch")
        .description("Watch a workflow run")
        .argument("<run-id>")
        .option("--from-step <step-id>", "resume inclusively from a step")
        .option("--include <resource>", "include related sessions", includeResource)
        .action(async (runId: string, options: { fromStep?: string; include?: "sessions" }, command: Command) => {
            const client = await runtime.client(command)
            const output = runtime.output(command)
            for await (const item of watchRun(client, {
                runId,
                ...(options.fromStep !== undefined ? { fromStepId: options.fromStep } : {}),
                includeSessions: options.include === "sessions",
                signal: runtime.signal
            })) {
                await emitWatchItem(runtime, command, output, item)
            }
        })
    runs.command("resume")
        .description("Resume an interrupted workflow run")
        .argument("<run-id>")
        .action(async (runId: string, _options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.resumeRun({ runId }, { signal: runtime.signal })
            await runtime.emit(command, ResumeRunResponseSchema, response, () => `${response.runId}\n`)
        })
    runs.command("rerun")
        .description("Rerun a workflow from a step")
        .argument("<run-id>")
        .requiredOption("--from <step-key>", "step key to rerun from")
        .action(async (runId: string, options: { from: string }, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.rerunRun({ runId, fromStepKey: options.from }, { signal: runtime.signal })
            await runtime.emit(command, RerunRunResponseSchema, response, () => `${response.runId}\n`)
        })
}

async function getRun(runtime: Runtime, command: Command, runId: string, options: RunGetOptions): Promise<void> {
    const client = await runtime.client(command)
    const output = runtime.output(command)
    const initial = await client.getRun({ runId }, { signal: runtime.signal })
    const initialSessions = options.include === "sessions" ? await getRunSessions(client, initial, runtime.signal) : []
    await emitRunSnapshot(output, initial, initialSessions)

    const status = initial.run?.metadata?.status
    if (options.watch !== true || status === undefined || terminalStatus(status)) {
        if (options.watch === true && status !== undefined && failedStatus(status)) runtime.failResult()
        return
    }

    const knownSteps = new Map(initial.run?.steps.map((step) => [step.id, stepFingerprint(step)]))
    const sessionCursors = new Map(
        initialSessions.flatMap((response) => {
            const session = response.session
            if (session === undefined) return []
            return [[session.id, session.messages.at(-1)?.id] as const]
        })
    )
    const fromStepId = watchFromStepId(initial.run?.steps ?? [])
    for await (const item of watchRun(client, {
        runId,
        ...(fromStepId !== undefined ? { fromStepId } : {}),
        includeSessions: options.include === "sessions",
        signal: runtime.signal,
        knownSteps,
        sessionCursors
    })) {
        await emitWatchItem(runtime, command, output, item)
    }

    const final = await client.getRun({ runId }, { signal: runtime.signal })
    await emitRunSnapshot(output, final, [])
    if (final.run?.metadata !== undefined && failedStatus(final.run.metadata.status)) runtime.failResult()
}

async function getRunSessions(
    client: LoopyClient,
    response: GetRunResponse,
    signal: AbortSignal
): Promise<GetSessionResponse[]> {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const step of response.run?.steps ?? []) {
        if (step.sessionId === undefined || seen.has(step.sessionId)) continue
        seen.add(step.sessionId)
        ids.push(step.sessionId)
    }
    return Promise.all(ids.map((sessionId) => client.getSession({ sessionId }, { signal })))
}

async function emitRunSnapshot(
    output: Output,
    response: GetRunResponse,
    sessionResponses: GetSessionResponse[]
): Promise<void> {
    if (output.json) {
        await output.proto(GetRunResponseSchema, response)
        for (const session of sessionResponses) await output.proto(GetSessionResponseSchema, session)
        return
    }
    const sessions = new Map<string, Session>()
    for (const response of sessionResponses) {
        if (response.session !== undefined) sessions.set(response.session.id, response.session)
    }
    await output.write(formatRun(response, sessions))
}

function observeRunFailure(runtime: Runtime, response: WatchRunResponse | undefined): void {
    if (response?.item.case === "run" && failedStatus(response.item.value.status)) runtime.failResult()
}

async function emitWatchItem(runtime: Runtime, command: Command, output: Output, item: RunWatchItem): Promise<void> {
    if (item.kind === "session-error") {
        await runtime.reportError(command, item.error, {
            prefix: `session ${item.sessionId}: `,
            details: { scope: "session", sessionId: item.sessionId }
        })
        return
    }
    if (output.json) await output.proto(item.schema, item.message)
    else if (item.kind === "run") await output.write(formatRunWatch(item.message))
    else if (item.message.message !== undefined) await output.write(formatSessionMessage(item.message.message))
    observeRunFailure(runtime, item.kind === "run" ? item.message : undefined)
}

async function* watchRun(client: LoopyClient, options: RunWatchOptions): AsyncGenerator<RunWatchItem, void, void> {
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal.reason)
    if (options.signal.aborted) abort()
    else options.signal.addEventListener("abort", abort, { once: true })

    const queue: RunWatchItem[] = []
    const knownSteps = new Map(options.knownSteps)
    const knownSessions = new Set(options.sessionCursors?.keys())
    let active = 0
    let failure: unknown
    let wake: (() => void) | undefined

    const notify = () => {
        const current = wake
        wake = undefined
        current?.()
    }
    const fail = (error: unknown) => {
        if (failure === undefined) failure = error
        controller.abort(error)
    }
    const start = <T>(
        source: AsyncIterable<T>,
        receive: (value: T) => void,
        onError: (error: unknown) => void = fail
    ) => {
        active++
        void (async () => {
            try {
                for await (const value of source) receive(value)
            } catch (error) {
                onError(error)
            } finally {
                active--
                notify()
            }
        })()
    }
    const startSession = (sessionId: string, afterMessageId?: string) => {
        if (knownSessions.has(sessionId) && !options.sessionCursors?.has(sessionId)) return
        knownSessions.add(sessionId)
        start(
            client.watchSession(
                {
                    sessionId,
                    ...(afterMessageId !== undefined ? { afterMessageId } : {})
                },
                { signal: controller.signal }
            ),
            (message) => {
                queue.push({ kind: "session", schema: WatchSessionResponseSchema, message })
                notify()
            },
            (error) => {
                if (controller.signal.aborted) return
                queue.push({ kind: "session-error", sessionId, error })
                notify()
            }
        )
    }

    start(
        client.watchRun(
            {
                runId: options.runId,
                ...(options.fromStepId !== undefined ? { fromStepId: options.fromStepId } : {})
            },
            { signal: controller.signal }
        ),
        (message) => {
            let emit = true
            if (message.item.case === "step") {
                const step = message.item.value
                const fingerprint = stepFingerprint(step)
                if (knownSteps.get(step.id) === fingerprint) emit = false
                knownSteps.set(step.id, fingerprint)
                if (options.includeSessions && step.sessionId !== undefined && !knownSessions.has(step.sessionId)) {
                    startSession(step.sessionId)
                }
            }
            if (emit) {
                queue.push({ kind: "run", schema: WatchRunResponseSchema, message })
                notify()
            }
        }
    )

    if (options.includeSessions && options.sessionCursors !== undefined) {
        for (const [sessionId, afterMessageId] of options.sessionCursors) {
            startSession(sessionId, afterMessageId)
        }
    }

    try {
        while (active > 0 || queue.length > 0) {
            const item = queue.shift()
            if (item !== undefined) {
                yield item
                continue
            }
            await new Promise<void>((resolve) => {
                wake = resolve
            })
        }
        if (failure !== undefined) throw failure
    } finally {
        options.signal.removeEventListener("abort", abort)
        controller.abort()
    }
}

function formatRuns(response: ListRunsResponse): string {
    if (response.runs.length === 0) return "No runs found.\n"
    return table(
        ["ID", "WORKFLOW", "KEY", "ATTEMPT", "STATUS", "STARTED", "ENDED"],
        response.runs.map((run) => [
            run.id,
            run.workflowName,
            run.key,
            String(run.attempt),
            executionStatus(run.status),
            timestamp(run.startedAt),
            timestamp(run.endedAt)
        ])
    )
}

function formatRun(response: GetRunResponse, sessions: ReadonlyMap<string, Session> = new Map()): string {
    if (response.run === undefined) return "Run response is empty.\n"
    return formatWorkflowRun(response.run, sessions)
}

function formatRunWatch(response: WatchRunResponse): string {
    if (response.item.case === "step") return formatStepUpdate(response.item.value)
    if (response.item.case === "run") return formatRunUpdate(response.item.value)
    return "Run update is empty.\n"
}

function formatWorkflowRun(run: WorkflowRun, sessions: ReadonlyMap<string, Session>): string {
    const metadata = run.metadata
    const lines =
        metadata === undefined
            ? ["Run metadata is missing."]
            : [
                  `Run: ${metadata.id}`,
                  `Workflow: ${metadata.workflowName}`,
                  `Key: ${metadata.key}`,
                  `Attempt: ${metadata.attempt}`,
                  `Status: ${executionStatus(metadata.status)}`,
                  `Started: ${timestamp(metadata.startedAt)}`,
                  `Ended: ${timestamp(metadata.endedAt)}`
              ]
    if (run.errorCode !== undefined) lines.push(`Error code: ${run.errorCode}`)
    if (run.error !== undefined) lines.push(`Error: ${run.error}`)
    if (run.outputJson !== undefined) lines.push("", "Output:", indent(prettyJson(run.outputJson)))
    lines.push("", "Steps:")
    if (run.steps.length === 0) {
        lines.push("  None")
    } else {
        for (const step of run.steps) {
            lines.push(indent(formatStep(step).trimEnd()))
            if (step.sessionId !== undefined) {
                const session = sessions.get(step.sessionId)
                if (session !== undefined) lines.push(indent(formatSessionValue(session).trimEnd(), 2))
            }
        }
    }
    lines.push("", "Artifacts:")
    if (run.artifacts.length === 0) {
        lines.push("  None")
    } else {
        for (const artifact of run.artifacts) lines.push(indent(formatArtifactValue(artifact), 1))
    }
    return `${lines.join("\n")}\n`
}

function formatStep(step: Step): string {
    const lines = [
        `${step.seq}. ${step.key} (${stepKind(step.kind)})`,
        `ID: ${step.id}`,
        `Name: ${step.name}`,
        `Status: ${executionStatus(step.status)}`,
        `Started: ${timestamp(step.startedAt)}`,
        `Ended: ${timestamp(step.endedAt)}`
    ]
    if (step.sessionId !== undefined) lines.push(`Session: ${step.sessionId}`)
    if (step.artifactId !== undefined) lines.push(`Artifact: ${step.artifactId}`)
    if (step.eventKey !== undefined) lines.push(`Event: ${step.eventKey}`)
    if (step.snapshotRef !== undefined) lines.push(`Snapshot: ${step.snapshotRef}`)
    if (step.errorCode !== undefined) lines.push(`Error code: ${step.errorCode}`)
    if (step.error !== undefined) lines.push(`Error: ${step.error}`)
    if (step.outputJson !== undefined) lines.push("Output:", indent(prettyJson(step.outputJson)))
    return `${lines.join("\n")}\n`
}

function formatStepUpdate(step: Step): string {
    const suffix = step.error === undefined ? "" : `: ${step.error}`
    return `Step ${step.key} (${stepKind(step.kind)}): ${executionStatus(step.status)}${suffix}\n`
}

function formatRunUpdate(run: RunMetadata): string {
    return `Run ${run.id}: ${executionStatus(run.status)}\n`
}

function stepFingerprint(step: Step): string {
    return toJsonString(StepSchema, step)
}

function watchFromStepId(steps: readonly Step[]): string | undefined {
    return steps.find((step) => step.status === ExecutionStatus.RUNNING)?.id ?? steps.at(-1)?.id
}

function terminalStatus(status: ExecutionStatus): boolean {
    return status !== ExecutionStatus.RUNNING
}

function failedStatus(status: ExecutionStatus): boolean {
    return status === ExecutionStatus.FAILED
}

function stepKind(value: StepKind): string {
    switch (value) {
        case StepKind.CUSTOM:
            return "custom"
        case StepKind.ARTIFACT:
            return "artifact"
        case StepKind.LLM:
            return "llm"
        case StepKind.AGENT:
            return "agent"
        case StepKind.EVENT:
            return "event"
        default:
            return "unspecified"
    }
}

function collectStatus(value: string, previous: ExecutionStatus[]): ExecutionStatus[] {
    previous.push(parseStatus(value))
    return previous
}

function parseStatus(value: string): ExecutionStatus {
    switch (value) {
        case "interrupted":
            return ExecutionStatus.INTERRUPTED
        case "running":
            return ExecutionStatus.RUNNING
        case "succeeded":
            return ExecutionStatus.SUCCEEDED
        case "failed":
            return ExecutionStatus.FAILED
        default:
            throw new InvalidArgumentError(`allowed values are interrupted, running, succeeded, and failed`)
    }
}

function positiveInteger(value: string): number {
    if (!/^[1-9]\d*$/.test(value)) throw new InvalidArgumentError("must be a positive integer")
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed > 0xffff_ffff) {
        throw new InvalidArgumentError("must be no greater than 4294967295")
    }
    return parsed
}

function includeResource(value: string): "sessions" {
    if (value !== "sessions") throw new InvalidArgumentError("only sessions can be included")
    return value
}
