import {
    artifactLines,
    blank,
    jsonLines,
    line,
    outputLines,
    tableLines,
    type ArtifactFixture,
    type Scenario,
    type TerminalLine
} from "./terminal"

const runId = "fK8pQ2mV6xD9sT4nW1cJ7"
const stringRunId = "nR5cV8mX2qL7dP1sK4wH9"
const sessionId = "B3rL8yP1vN6kM4tH9qX2a"
const contextSessionId = "E7mQ2cN9vK4sR1xP6tW8d"
const verdictSessionId = "J4wT9bH2nF7qC5yM1sV8k"
const draftSessionId = "D6qN1vR8mK3xT9cP4wH7s"
const artifactId = "U5zC7dF2jR9wE1bG6sA4n"
const rerunId = "R8qM3vD7kL2xP9sF5wN1c"
const releaseRunId = "cJ6yF1bL8qS3wG9nE2zM5"
const parallelRunId = "pA7rN2xC9mK4vT8qL1wD6"
const testSessionId = "T9cM4qV1xR7nK2wP8dL5s"
const summarySessionId = "S2vH8mQ5cN1xR7kD4wP9t"
const failedRunId = "F4mR8qN2vK7xC1pL9wT5d"
const startedAt = "2026-08-13T09:00:00.000Z"
const verdictEndedAt = "2026-08-13T09:00:56.000Z"
const endedAt = "2026-08-13T09:00:56.200Z"
const artifactFile = `artifacts/${runId}/artifact-review-summary-70303574`
const completedOutput = {
    verdict: "approve",
    summary: "Both reviewers agree the change is ready."
}
const prepareOutput = "Review pull request 482 in acme/clankhouse."
const reviewOutput = "No blocking issues found."
const verdictOutput = "approve"
const artifactOutput = {
    id: artifactId,
    runId,
    name: "review-summary",
    file: artifactFile,
    kind: "text",
    mimeType: "text/markdown"
}
const completedArtifacts: ArtifactFixture[] = [
    {
        id: artifactId,
        name: "review-summary",
        kind: "text",
        mediaType: "text/markdown"
    }
]
const codeReviewOutput = { verdict: "approve", note: "No blocking API issues." }
const testReviewOutput = { verdict: "pass", tests: 38 }
const parallelOutput = {
    verdict: "approve",
    summary: "Code review and focused tests passed."
}
const workflowInputSchema = {
    type: "object",
    properties: {
        repositoryPath: {
            type: "string"
        }
    },
    required: ["repositoryPath"]
}
const workflowOutputSchema = {
    type: "string"
}

const contextSessionMessages = [
    "user: Prepare a concise review brief for pull request 482 in acme/clankhouse.",
    "assistant: Review pull request 482 in acme/clankhouse."
]
const reviewSessionMessages = [
    "user: Review the proposed CLI output changes for correctness.",
    "assistant: I’ll inspect the CLI formatter and its tests.",
    "tool: read cli/src/cmd/runs.ts",
    "tool: notion.read_notion_page (mcp)",
    "assistant: No blocking issues found."
]
const reviewSessionToolIoMessages = [
    "user: Review the proposed CLI output changes for correctness.",
    "assistant: I’ll inspect the CLI formatter and its tests.",
    "tool: read cli/src/cmd/runs.ts",
    'input: {"id":"call_01","tool":"read","input":{"path":"cli/src/cmd/runs.ts"}}',
    'tool_result: {"toolUseId":"call_01","status":"succeeded","content":{"lines":512}}',
    "tool: notion.read_notion_page (mcp)",
    'input: {"id":"call_02","tool":"notion.read_notion_page","input":{"page_id":"cli-output"}}',
    'tool_result: {"toolUseId":"call_02","status":"succeeded","content":{"title":"CLI output"}}',
    "assistant: No blocking issues found."
]
const verdictSessionMessages = ["user: Return the final verdict for the pull request review.", "assistant: approve"]
const failedReviewSessionMessages = [
    "user: Draft release notes after checking the repository.",
    "assistant: I’ll check the repository before drafting the notes.",
    "tool: shell git diff --check",
    "tool_result: failed: README.md:18: trailing whitespace"
]
const parallelReviewSessionMessages = [
    "user: Review the runs output changes for correctness and API regressions.",
    "assistant: I’ll trace the watch paths and their edge cases.\nI’ll start with the event model.",
    "tool: read cli/src/cmd/runs",
    "assistant: The API flow looks sound; no blocking issues."
]
const testSessionMessages = [
    "user: Validate the change with the focused CLI tests.",
    "assistant: I’ll run the run-output and CLI suites.",
    "tool: shell pnpm --filter @clankhouse/cli test",
    "assistant: All focused tests pass."
]
const summarySessionMessages = ["user: Combine the code and test reviews into a final verdict.", "assistant: approve"]

function stepLines(
    seq: number,
    key: string,
    kind: string,
    started: string,
    ended: string,
    details: {
        session?: string
        artifact?: string
    } = {}
): TerminalLine[] {
    return [
        line(`${seq}. ${key}`, 1),
        stepNestedLine(`${kind} · succeeded · ${formatDuration(started, ended)}`, 2),
        ...(details.session === undefined ? [] : [blank(), stepNestedLine(`Session ${details.session}`, 2)]),
        ...(details.artifact === undefined ? [] : [blank(), stepNestedLine(`Artifact ${details.artifact}`, 2)])
    ]
}

function stepNestedLine(text: string, depth: number): TerminalLine {
    return line(` ${text}`, depth)
}

function stepNestedJsonLines(value: unknown, depth: number): TerminalLine[] {
    return jsonLines(value, depth).map((item) => stepNestedLine(item.text, item.depth ?? depth))
}

function stepOutputLines(value: unknown): TerminalLine[] {
    return [blank(), stepNestedLine("Output", 2), ...stepNestedJsonLines(value, 3)]
}

function formatDuration(started: string, ended: string): string {
    const milliseconds = Date.parse(ended) - Date.parse(started)
    const totalMinutes = Math.floor(milliseconds / 60_000)
    if (totalMinutes >= 60) {
        const hours = Math.floor(totalMinutes / 60)
        return `${hours}h${totalMinutes % 60}m`
    }
    if (totalMinutes >= 1) {
        const seconds = Math.floor(milliseconds / 1000) % 60
        return `${totalMinutes}m${seconds}s`
    }
    return `${Number((milliseconds / 1000).toFixed(3))}s`
}

function runLines(
    id: string,
    workflow: string,
    key: string,
    attempt: number,
    status: string,
    started: string,
    ended: string
): TerminalLine[] {
    return [
        line(`Run ${id}`),
        line(`${workflow} · ${key} · attempt ${attempt}`, 1),
        line(`${status} · ${formatDuration(started, ended)}`, 1)
    ]
}

function sessionLines(id: string, client: string, provider: string, model: string, messages: string[]): TerminalLine[] {
    return [
        blank(),
        stepNestedLine(`Session ${id}`, 2),
        stepNestedLine(`${client} · ${provider}/${model}`, 3),
        blank(),
        stepNestedLine("Messages", 3),
        ...messages.flatMap(sessionMessageLines)
    ]
}

function alignedSessionMessageLines(message: string): string[] {
    const separator = message.indexOf(":")
    if (separator === -1) return message.split("\n")
    const rawRole = message.slice(0, separator)
    const role = rawRole === "tool_result" ? "result" : rawRole
    const prefix = role.padEnd(11)
    const content = message.slice(separator + 1)
    return (content.startsWith(" ") ? content.slice(1) : content)
        .split("\n")
        .map((content, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${content}`.trimEnd())
}

function sessionMessageLines(message: string): TerminalLine[] {
    return alignedSessionMessageLines(message).map((text) => stepNestedLine(text, 4))
}

function sessionHeaderLines(
    id: string,
    kind: string,
    client: string,
    provider: string,
    model: string,
    state: string
): TerminalLine[] {
    return [line(`Session ${id}`), line(`${kind} · ${client} · ${provider}/${model}`, 1), line(state, 1)]
}

function standaloneSessionMessageLines(message: string): TerminalLine[] {
    return alignedSessionMessageLines(message).map((text) => line(text, 1))
}

function completedRunLines(includeSessions: boolean, includeToolIo = false): TerminalLine[] {
    return [
        ...runLines(runId, "review-pull-request", "pr-482", 1, "succeeded", startedAt, endedAt),
        blank(),
        line("Steps"),
        ...stepLines(1, "prepare-context", "llm", startedAt, "2026-08-13T09:00:01.200Z", {
            ...(includeSessions ? {} : { session: contextSessionId })
        }),
        ...(includeSessions
            ? sessionLines(contextSessionId, "openai", "openai", "gpt-5.4", contextSessionMessages)
            : []),
        ...stepOutputLines(prepareOutput),
        blank(),
        ...stepLines(2, "review-changes", "coding-agent", "2026-08-13T09:00:01.200Z", "2026-08-13T09:00:42.000Z", {
            ...(includeSessions ? {} : { session: sessionId })
        }),
        ...(includeSessions
            ? sessionLines(
                  sessionId,
                  "codex",
                  "openai",
                  "gpt-5.4-codex",
                  includeToolIo ? reviewSessionToolIoMessages : reviewSessionMessages
              )
            : []),
        ...stepOutputLines(reviewOutput),
        blank(),
        ...stepLines(3, "synthesize-verdict", "llm", "2026-08-13T09:00:42.000Z", verdictEndedAt, {
            ...(includeSessions ? {} : { session: verdictSessionId })
        }),
        ...(includeSessions
            ? sessionLines(verdictSessionId, "openai", "openai", "gpt-5.4", verdictSessionMessages)
            : []),
        ...stepOutputLines(verdictOutput),
        blank(),
        ...stepLines(4, "artifact:review-summary", "artifact", verdictEndedAt, endedAt, {
            artifact: artifactId
        }),
        ...stepOutputLines(artifactOutput),
        ...artifactLines(completedArtifacts),
        ...outputLines(completedOutput)
    ]
}

type IncludedSessionFixture = {
    id: string
    client: string
    provider: string
    model: string
    messages: string[]
}

type ObservedStepFixture = {
    seq: number
    key: string
    kind: string
    status: string
    timing: string
    session?: IncludedSessionFixture
    output?: unknown
}

function observedStepLines(step: ObservedStepFixture): TerminalLine[] {
    const lines = [
        line(`${step.seq}. ${step.key}`, 1),
        stepNestedLine(`${step.kind} · ${step.status} · ${step.timing}`, 2)
    ]
    if (step.session !== undefined) {
        lines.push(
            ...sessionLines(
                step.session.id,
                step.session.client,
                step.session.provider,
                step.session.model,
                step.session.messages
            )
        )
    }
    if (step.output !== undefined) lines.push(...stepOutputLines(step.output))
    return lines
}

function runFrameLines(header: TerminalLine[], steps: TerminalLine[][], output?: unknown): TerminalLine[] {
    return [
        ...header,
        blank(),
        line("Steps"),
        ...steps.flatMap((step, index) => (index === 0 ? step : [blank(), ...step])),
        blank(),
        line("Artifacts"),
        line("None", 1),
        ...(output === undefined ? [] : outputLines(output))
    ]
}

function runningParallelRunLines(activeSteps: number): TerminalLine[] {
    return [
        line(`Run ${parallelRunId}`),
        line("review-pull-request · pr-482 · attempt 1", 1),
        line(`running · from 13:20 · ${activeSteps} active ${activeSteps === 1 ? "step" : "steps"}`, 1)
    ]
}

function prepareStep(status: "running" | "succeeded"): TerminalLine[] {
    return observedStepLines({
        seq: 1,
        key: "prepare-context",
        kind: "llm",
        status,
        timing: status === "running" ? "from 13:20" : "1.2s",
        session: {
            id: contextSessionId,
            client: "openai",
            provider: "openai",
            model: "gpt-5.4",
            messages: status === "running" ? contextSessionMessages.slice(0, 1) : contextSessionMessages
        },
        ...(status === "succeeded" ? { output: prepareOutput } : {})
    })
}

function codeReviewStep(status: "running" | "succeeded", messageCount: number): TerminalLine[] {
    return observedStepLines({
        seq: 2,
        key: "review-source",
        kind: "coding-agent",
        status,
        timing: status === "running" ? "from 13:20" : "40.8s",
        session: {
            id: sessionId,
            client: "codex",
            provider: "openai",
            model: "gpt-5.4-codex",
            messages: parallelReviewSessionMessages.slice(0, messageCount)
        },
        ...(status === "succeeded" ? { output: codeReviewOutput } : {})
    })
}

function testReviewStep(status: "running" | "succeeded", messageCount: number): TerminalLine[] {
    return observedStepLines({
        seq: 3,
        key: "validate-tests",
        kind: "coding-agent",
        status,
        timing: status === "running" ? "from 13:20" : "46.3s",
        session: {
            id: testSessionId,
            client: "claude",
            provider: "anthropic",
            model: "claude-opus-4.1",
            messages: testSessionMessages.slice(0, messageCount)
        },
        ...(status === "succeeded" ? { output: testReviewOutput } : {})
    })
}

function activityMessageLines(message: string): string[] {
    return alignedSessionMessageLines(message).map((text) => `  ${text}`.trimEnd())
}

function activityDetailLines(details: string[]): TerminalLine[] {
    return details.map((detail) => stepNestedLine(detail, 2))
}

function activityLines(time: string, owner: string, details: string[]): TerminalLine[] {
    return [blank(), line(`${time}  ${owner}`, 1), ...activityDetailLines(details)]
}

const parallelActivityChunks = [
    activityLines("13:20:00", "1. prepare-context", [
        "llm · running",
        `Session ${contextSessionId} · openai · openai/gpt-5.4`,
        ...activityMessageLines(contextSessionMessages[0]!)
    ]),
    activityDetailLines([
        ...activityMessageLines(contextSessionMessages[1]!),
        "llm · succeeded · 1.2s",
        `Output ${JSON.stringify(prepareOutput)}`
    ]),
    activityLines("13:20:02", "2. review-source", [
        "coding-agent · running",
        `Session ${sessionId} · codex · openai/gpt-5.4-codex`,
        ...parallelReviewSessionMessages.slice(0, 2).flatMap(activityMessageLines)
    ]),
    activityLines("13:20:02", "3. validate-tests", [
        "coding-agent · running",
        `Session ${testSessionId} · claude · anthropic/claude-opus-4.1`,
        ...testSessionMessages.slice(0, 2).flatMap(activityMessageLines)
    ]),
    activityLines("13:20:11", "2. review-source", [
        "Session (continued)",
        ...parallelReviewSessionMessages.slice(2, 3).flatMap(activityMessageLines)
    ]),
    activityLines("13:20:18", "3. validate-tests", [
        "Session (continued)",
        ...testSessionMessages.slice(2, 3).flatMap(activityMessageLines)
    ]),
    activityLines("13:20:42", "2. review-source", [
        "Session (continued)",
        ...activityMessageLines(parallelReviewSessionMessages[3]!),
        "coding-agent · succeeded · 40.8s",
        `Output ${JSON.stringify(codeReviewOutput)}`
    ]),
    activityLines("13:20:47", "3. validate-tests", [
        "Session (continued)",
        ...activityMessageLines(testSessionMessages[3]!),
        "coding-agent · succeeded · 46.3s",
        `Output ${JSON.stringify(testReviewOutput)}`
    ]),
    activityLines("13:20:48", "4. synthesize-verdict", [
        "llm · running",
        `Session ${summarySessionId} · openai · openai/gpt-5.4`,
        ...summarySessionMessages.flatMap(activityMessageLines),
        "llm · succeeded · 8.7s",
        'Output "approve"'
    ]),
    activityLines("13:20:56", `Run ${parallelRunId}`, ["succeeded · 56.2s", `Output ${JSON.stringify(parallelOutput)}`])
]

const parallelActivityHeader = [
    line(`Run ${parallelRunId}`),
    line("review-pull-request · pr-482 · attempt 1", 1),
    line("running · from 13:20", 1),
    blank(),
    line("Activity")
]

const parallelWatchChunks = [
    parallelActivityHeader,
    parallelActivityChunks[0]!.slice(1),
    ...parallelActivityChunks.slice(1)
]
const getWatchInitialLines = runFrameLines(runningParallelRunLines(2), [
    prepareStep("succeeded"),
    codeReviewStep("running", 3),
    testReviewStep("running", 3)
])
const getWatchUpdateChunks = parallelActivityChunks.slice(6)
const getWatchChunks = [
    [...getWatchInitialLines, blank(), line("Updates")],
    getWatchUpdateChunks[0]!.slice(1),
    ...getWatchUpdateChunks.slice(1)
]
const failedWatchChunks = [
    [
        line(`Run ${failedRunId}`),
        line("release-notes · v0.1.0 · attempt 1", 1),
        line("running · from 14:05", 1),
        blank(),
        line("Activity")
    ],
    activityLines("14:05:00", "1. collect-changes", ["custom · succeeded · 0.4s", 'Output {"count":3}']).slice(1),
    activityLines("14:05:01", "2. draft-notes", [
        "coding-agent · running",
        `Session ${draftSessionId} · codex · openai/gpt-5.4-codex`,
        ...failedReviewSessionMessages.slice(0, 3).flatMap(activityMessageLines)
    ]),
    activityDetailLines([
        ...activityMessageLines(failedReviewSessionMessages[3]!),
        "coding-agent · failed · 12s",
        "Error Repository checks failed"
    ]),
    activityLines("14:05:12", `Run ${failedRunId}`, ["failed · 12.4s", "Error Repository checks failed"])
]
const sessionGetLines = [
    ...sessionHeaderLines(sessionId, "coding-agent", "codex", "openai", "gpt-5.4-codex", "succeeded · 40.8s"),
    blank(),
    line("Messages"),
    ...reviewSessionMessages.flatMap(standaloneSessionMessageLines)
]
const sessionGetToolIoLines = [
    ...sessionHeaderLines(sessionId, "coding-agent", "codex", "openai", "gpt-5.4-codex", "succeeded · 40.8s"),
    blank(),
    line("Messages"),
    ...reviewSessionToolIoMessages.flatMap(standaloneSessionMessageLines)
]
const sessionWatchChunks = [
    [
        ...sessionHeaderLines(sessionId, "coding-agent", "codex", "openai", "gpt-5.4-codex", "running · from 09:00"),
        blank(),
        line("Messages")
    ],
    ...reviewSessionMessages.map(standaloneSessionMessageLines)
]

export const scenarios: Scenario[] = [
    {
        id: "workflows-list",
        group: "Workflows",
        label: "List workflows",
        command: "clank workflows list",
        summary: "The CLI prints one registered workflow name per line.",
        note: "There is no heading or table in the current human-readable output.",
        delivery: "instant",
        lines: [line("dual-review"), line("hello-world"), line("review-pull-request")]
    },
    {
        id: "workflows-get",
        group: "Workflows",
        label: "Get workflow",
        command: "clank workflows get dual-review",
        summary: "A workflow definition groups its name and input and output schemas into a compact snapshot.",
        note: "The entity header mirrors run and session snapshots; schemas sit beneath short semantic headings.",
        delivery: "instant",
        lines: [
            line("Workflow dual-review"),
            blank(),
            line("Input"),
            ...jsonLines(workflowInputSchema, 1),
            blank(),
            line("Output"),
            ...jsonLines(workflowOutputSchema, 1)
        ]
    },
    {
        id: "watch-success",
        group: "Live runs",
        label: "Watch concurrent agents",
        command: `clank runs watch ${parallelRunId} --include sessions`,
        summary: "Watch emits the same append-only, scoped activity blocks to TTY and redirected output.",
        note: "Concurrent messages stay nested beneath their owning step. Contiguous updates append to the current owner block; after another owner interleaves, the session resumes in a new timestamped block.",
        delivery: "streaming",
        lines: parallelWatchChunks.flat(),
        chunks: parallelWatchChunks
    },
    {
        id: "watch-failure",
        group: "Live runs",
        label: "Run fails",
        command: `clank runs watch ${failedRunId} --include sessions`,
        summary: "A failed step is appended with its scoped error before the terminal run failure.",
        note: "Both output targets repeat the failed step scope before the terminal run failure and still exit non-zero.",
        delivery: "streaming",
        lines: failedWatchChunks.flat(),
        chunks: failedWatchChunks
    },
    {
        id: "get-watch-success",
        group: "Live runs",
        label: "Get and watch run",
        command: `clank runs get ${parallelRunId} --include sessions --watch`,
        summary: "Get with watch prints its initial snapshot, then owner-scoped updates on both output targets.",
        note: "The completed update carries the final output without repeating the full snapshot.",
        delivery: "streaming",
        lines: getWatchChunks.flat(),
        chunks: getWatchChunks
    },
    {
        id: "runs-start",
        group: "Run control",
        label: "Start run",
        command: "clank runs start review-pull-request --input input.json",
        summary: "Starting a run prints its identifier.",
        note: "The current human-readable response contains only the run ID.",
        delivery: "instant",
        lines: [line(runId)]
    },
    {
        id: "runs-resume",
        group: "Run control",
        label: "Resume run",
        command: `clank runs resume ${runId}`,
        summary: "Resuming a run prints its identifier.",
        note: "The current human-readable response contains only the run ID.",
        delivery: "instant",
        lines: [line(runId)]
    },
    {
        id: "runs-rerun",
        group: "Run control",
        label: "Rerun from step",
        command: `clank runs rerun ${runId} --from review-changes`,
        summary: "Rerunning from a step prints the new run identifier.",
        note: "The source run and step boundary appear in the command, not the response.",
        delivery: "instant",
        lines: [line(rerunId)]
    },
    {
        id: "run-details",
        group: "Snapshots",
        label: "Completed run",
        command: `clank runs get ${runId}`,
        summary: "A run snapshot prints metadata, detailed steps, artifacts, and its final output in that order.",
        note: "Run and step metadata is grouped beneath semantic headings using indentation and spacing.",
        delivery: "instant",
        startAtTop: true,
        lines: completedRunLines(false)
    },
    {
        id: "run-details-sessions",
        group: "Snapshots",
        label: "Completed run including sessions",
        command: `clank runs get ${runId} --include sessions`,
        summary: "Included session snapshots are nested beneath the steps that reference them.",
        note: "Tool calls use compact semantic summaries; successful results stay hidden unless tool I/O is requested.",
        delivery: "instant",
        startAtTop: true,
        lines: completedRunLines(true)
    },
    {
        id: "run-details-verbose",
        group: "Snapshots",
        label: "Verbose completed run",
        command: `clank runs get ${runId} --verbose`,
        summary: "Verbose output includes related sessions and their complete tool inputs and results.",
        note: "Each tool keeps its compact summary and gains aligned input and result envelopes beneath it.",
        delivery: "instant",
        startAtTop: true,
        lines: completedRunLines(true, true)
    },
    {
        id: "string-output",
        group: "Snapshots",
        label: "String output",
        command: `clank runs get ${stringRunId}`,
        summary: "A JSON string output remains quoted in a run snapshot.",
        note: "The Output section uses the same JSON pretty-printer for strings and structured values.",
        delivery: "instant",
        startAtTop: true,
        lines: [
            ...runLines(
                stringRunId,
                "release-notes",
                "v0.1.0",
                1,
                "succeeded",
                "2026-08-13T10:15:00.000Z",
                "2026-08-13T10:15:04.800Z"
            ),
            blank(),
            line("Steps"),
            ...stepLines(1, "collect-changes", "custom", "2026-08-13T10:15:00.000Z", "2026-08-13T10:15:00.400Z"),
            ...stepOutputLines({ count: 3 }),
            blank(),
            ...stepLines(2, "draft-notes", "llm", "2026-08-13T10:15:00.400Z", "2026-08-13T10:15:04.800Z", {
                session: draftSessionId
            }),
            ...stepOutputLines("Release notes are ready for review."),
            blank(),
            line("Artifacts"),
            line("None", 1),
            ...outputLines("Release notes are ready for review.")
        ]
    },
    {
        id: "runs-list",
        group: "Snapshots",
        label: "Recent runs",
        command: "clank runs list --limit 3",
        summary: "Recent runs are printed in a seven-column table.",
        note: "Started and ended values use full ISO timestamps; a missing end time is shown as a dash.",
        delivery: "instant",
        lines: tableLines(
            ["ID", "WORKFLOW", "KEY", "ATTEMPT", "STATUS", "STARTED", "ENDED"],
            [
                [releaseRunId, "publish-release", "release-0.1", "1", "running", "2026-08-13T11:20:00.000Z", "-"],
                ["aP4vR9tN2xH7mK1dQ6sW8", "release-notes", "v0.1.0", "1", "running", "2026-08-13T11:17:18.000Z", "-"],
                [runId, "review-pull-request", "pr-482", "1", "succeeded", startedAt, endedAt]
            ]
        )
    },
    {
        id: "sessions-get",
        group: "Sessions",
        label: "Get session",
        command: `clank sessions get ${sessionId}`,
        summary:
            "A session snapshot groups its identity, client and model metadata, terminal state, and message history.",
        note: "Common tools use semantic summaries, MCP tools show their source kind, and successful results are omitted.",
        delivery: "instant",
        startAtTop: true,
        lines: sessionGetLines
    },
    {
        id: "sessions-get-tool-io",
        group: "Sessions",
        label: "Get session with tool I/O",
        command: `clank sessions get ${sessionId} --include tool-io`,
        summary: "Tool I/O adds complete raw inputs and results without replacing compact summaries.",
        note: "The explicit include and global verbose flag produce the same session detail level.",
        delivery: "instant",
        startAtTop: true,
        lines: sessionGetToolIoLines
    },
    {
        id: "sessions-watch",
        group: "Sessions",
        label: "Watch session",
        command: `clank sessions watch ${sessionId}`,
        summary: "Session watch emits an append-only stream of aligned messages.",
        note: "Existing history and live arrivals share compact tool formatting; hidden results create no empty stream chunks.",
        delivery: "streaming",
        lines: sessionWatchChunks.flat(),
        chunks: sessionWatchChunks
    },
    {
        id: "artifacts-get",
        group: "Artifacts",
        label: "Get artifact metadata",
        command: `clank artifacts get ${artifactId}`,
        summary: "Artifact metadata groups identity, format, ownership, and storage location into a compact snapshot.",
        note: "Name, kind, and media type share one summary line; the owning run and file remain explicit references.",
        delivery: "instant",
        lines: [
            line(`Artifact ${artifactId}`),
            line("review-summary · text · text/markdown", 1),
            line(`Run ${runId}`, 1),
            line(`File ${artifactFile}`, 1)
        ]
    },
    {
        id: "artifacts-read",
        group: "Artifacts",
        label: "Read artifact",
        command: `clank artifacts read ${artifactId}`,
        summary: "Artifact bytes are written directly to standard output.",
        note: "There is no presentation wrapper around the payload.",
        delivery: "streaming",
        lines: [
            line("# Review summary"),
            blank(),
            line("Verdict: approve"),
            blank(),
            line("Both reviewers agree the change is ready.")
        ]
    },
    {
        id: "artifacts-copy",
        group: "Artifacts",
        label: "Copy artifact",
        command: `clank artifacts copy ${artifactId} ./review-summary.md`,
        summary: "Copy confirms the artifact ID and resolved destination.",
        note: "The simulated command runs from /workspace, so the destination is absolute in the response.",
        delivery: "instant",
        lines: [line(`Copied ${artifactId} to /workspace/review-summary.md`)]
    },
    {
        id: "events-emit",
        group: "Events",
        label: "Emit event",
        command: `printf '{"ok":true}' | clank events emit approval:release-0.1 --input -`,
        summary: "A successful event emission prints the event key.",
        note: "The current confirmation is prefixed with Event emitted.",
        delivery: "instant",
        lines: [line("Event emitted: approval:release-0.1")]
    },
    {
        id: "run-workflow",
        group: "Run control",
        label: "Run workflow",
        command: "clank run hello-world",
        summary: "The attached run command prints the workflow's raw output JSON after completion.",
        note: "TTY and redirected sessions currently receive the same bare output.",
        delivery: "instant",
        lines: [line('"/tmp/clankhouse-hello-world-AbCdEf"')]
    }
]
