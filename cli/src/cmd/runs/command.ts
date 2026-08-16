import { toJsonString } from "@bufbuild/protobuf"
import {
    ExecutionStatus,
    GetRunResponseSchema,
    GetSessionResponseSchema,
    ListRunsResponseSchema,
    RerunRunResponseSchema,
    ResumeRunResponseSchema,
    StartRunResponseSchema,
    StepSchema,
    WatchRunResponseSchema,
    WatchSessionResponseSchema,
    type GetRunResponse,
    type GetSessionResponse,
    type Session,
    type StartRunResponse,
    type Step,
    type WatchRunResponse,
    type WatchSessionResponse,
    type WorkflowRun
} from "@loopy/server/proto"
import { InvalidArgumentError, type Command } from "commander"
import type { LoopyClient } from "../../client"
import { CliError } from "../../errors"
import { readJsonInput } from "../../io"
import type { Output } from "../../output"
import type { Runtime } from "../../runtime"
import {
    formatRun,
    formatRunId,
    formatRunOutput,
    formatRuns,
    formatRunWatch,
    formatSessionErrorPrefix,
    formatSessionWatch,
    formatStepUpdate
} from "./output"

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
    program
        .command("run")
        .description("Run a workflow and print its output")
        .argument("<workflow-name>")
        .option("--input <file|->", "JSON input file, or - for stdin")
        .action(async (workflowName: string, options: { input?: string }, command: Command) => {
            await runWorkflow(runtime, command, workflowName, options.input)
        })

    const runs = program.command("runs").description("Start and inspect workflow runs")
    runs.command("start")
        .description("Start a workflow run")
        .argument("<workflow-name>")
        .option("--input <file|->", "JSON input file, or - for stdin")
        .action(async (workflowName: string, options: { input?: string }, command: Command) => {
            const { response } = await startWorkflowRun(runtime, command, workflowName, options.input)
            await runtime.emit(command, StartRunResponseSchema, response, () => formatRunId(response.runId))
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
        .option("--include <resource>", "include related sessions", includeResource)
        .action(async (runId: string, options: { include?: "sessions" }, command: Command) => {
            const client = await runtime.client(command)
            const output = runtime.output(command)
            const renderedSteps = new Map<string, string>()
            for await (const item of watchRun(client, {
                runId,
                includeSessions: options.include === "sessions",
                signal: runtime.signal
            })) {
                await emitWatchItem(runtime, command, output, item, renderedSteps)
            }
        })
    runs.command("resume")
        .description("Resume an interrupted workflow run")
        .argument("<run-id>")
        .action(async (runId: string, _options: unknown, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.resumeRun({ runId }, { signal: runtime.signal })
            await runtime.emit(command, ResumeRunResponseSchema, response, () => formatRunId(response.runId))
        })
    runs.command("rerun")
        .description("Rerun a workflow from a step")
        .argument("<run-id>")
        .requiredOption("--from <step-key>", "step key to rerun from")
        .action(async (runId: string, options: { from: string }, command: Command) => {
            const client = await runtime.client(command)
            const response = await client.rerunRun({ runId, fromStepKey: options.from }, { signal: runtime.signal })
            await runtime.emit(command, RerunRunResponseSchema, response, () => formatRunId(response.runId))
        })
}

async function runWorkflow(
    runtime: Runtime,
    command: Command,
    workflowName: string,
    inputFile: string | undefined
): Promise<void> {
    const { client, response } = await startWorkflowRun(runtime, command, workflowName, inputFile)
    await waitForRunCompletion(client, response.runId, runtime.signal)
    const completed = await client.getRun({ runId: response.runId }, { signal: runtime.signal })
    const outputJson = completedRunOutput(response.runId, completed.run)
    if (outputJson !== undefined) await runtime.output(command).write(formatRunOutput(outputJson))
}

async function startWorkflowRun(
    runtime: Runtime,
    command: Command,
    workflowName: string,
    inputFile: string | undefined
): Promise<{ client: LoopyClient; response: StartRunResponse }> {
    const inputJson =
        inputFile === undefined ? undefined : await readJsonInput(inputFile, runtime.cwd, runtime.stdin, runtime.signal)
    const client = await runtime.client(command)
    const response = await client.startRun(
        {
            workflowName,
            ...(inputJson !== undefined ? { inputJson } : {})
        },
        { signal: runtime.signal }
    )
    return { client, response }
}

async function waitForRunCompletion(client: LoopyClient, runId: string, signal: AbortSignal): Promise<void> {
    for await (const response of client.watchRun({ runId }, { signal })) {
        if (response.item.case === "run" && terminalStatus(response.item.value.status)) return
    }
}

function completedRunOutput(runId: string, run: WorkflowRun | undefined): string | undefined {
    if (run?.metadata === undefined) throw new CliError("internal", "Run response is empty")
    if (run.metadata.status === ExecutionStatus.FAILED) {
        throw new CliError(run.errorCode ?? "workflow_run_failed", run.error ?? `Workflow run failed: ${runId}`)
    }
    if (run.metadata.status === ExecutionStatus.INTERRUPTED) {
        throw new CliError("workflow_run_interrupted", `Workflow run interrupted: ${runId}`)
    }
    if (run.metadata.status !== ExecutionStatus.SUCCEEDED) {
        throw new CliError("internal", `Workflow run did not finish: ${runId}`)
    }
    return run.outputJson
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
    const renderedSteps = new Map(initial.run?.steps.map((step) => [step.id, formatStepUpdate(step)]))
    for await (const item of watchRun(client, {
        runId,
        ...(fromStepId !== undefined ? { fromStepId } : {}),
        includeSessions: options.include === "sessions",
        signal: runtime.signal,
        knownSteps,
        sessionCursors
    })) {
        await emitWatchItem(runtime, command, output, item, renderedSteps)
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

async function emitWatchItem(
    runtime: Runtime,
    command: Command,
    output: Output,
    item: RunWatchItem,
    renderedSteps: Map<string, string>
): Promise<void> {
    if (item.kind === "session-error") {
        await runtime.reportError(command, item.error, {
            prefix: formatSessionErrorPrefix(item.sessionId),
            details: { scope: "session", sessionId: item.sessionId }
        })
        return
    }
    if (output.json) await output.proto(item.schema, item.message)
    else if (item.kind === "run") {
        const rendered = formatRunWatch(item.message)
        if (item.message.item.case !== "step" || renderedSteps.get(item.message.item.value.id) !== rendered) {
            if (item.message.item.case === "step") renderedSteps.set(item.message.item.value.id, rendered)
            await output.write(rendered)
        }
    } else if (item.message.message !== undefined) await output.write(formatSessionWatch(item.message.message))
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
