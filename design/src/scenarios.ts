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
const startedAt = "2026-08-13T09:00:00.000Z"
const verdictEndedAt = "2026-08-13T09:00:56.000Z"
const endedAt = "2026-08-13T09:00:56.200Z"
const releaseStartedAt = "2026-08-13T11:20:00.000Z"
const releaseEndedAt = "2026-08-13T11:21:18.600Z"
const artifactFile = `artifacts/${runId}/artifact-review-summary-70303574`
const completedOutput = {
    verdict: "approve",
    summary: "Both reviewers agree the change is ready."
}
const prepareOutput = "Review pull request 482 in acme/loopy."
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
const packageOutput = {
    file: "loopy-0.1.0.tgz",
    integrity: "sha512-m7GK9wQ3V1tC6xP8"
}
const approvalOutput = {
    key: "approval:release-0.1",
    event: {
        approved: true
    }
}
const releaseOutput = {
    package: "@loopy/core",
    version: "0.1.0"
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
    "user: Prepare a concise review brief for pull request 482 in acme/loopy.",
    "assistant: Review pull request 482 in acme/loopy."
]
const reviewSessionMessages = [
    "user: Review the proposed CLI output changes for correctness.",
    "assistant: I’ll inspect the CLI formatter and its tests.",
    'tool: {"id":"call_01","tool":"read","input":{"path":"cli/src/cmd/runs.ts"}}',
    'tool_result: {"toolUseId":"call_01","status":"succeeded","content":{"lines":512}}',
    "assistant: No blocking issues found."
]
const verdictSessionMessages = ["user: Return the final verdict for the pull request review.", "assistant: approve"]
const failedReviewSessionMessages = [
    "user: Draft release notes after checking the repository.",
    "assistant: I’ll check the repository before drafting the notes.",
    'tool: {"id":"call_01","tool":"shell","input":{"command":"git diff --check"}}',
    'tool_result: {"toolUseId":"call_01","status":"failed","content":null,"error":"README.md:18: trailing whitespace"}'
]

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
        ...messages.map(sessionMessageLine)
    ]
}

function sessionMessageLine(message: string): TerminalLine {
    const separator = message.indexOf(":")
    if (separator === -1) return stepNestedLine(message, 4)
    const rawRole = message.slice(0, separator)
    const role = rawRole === "tool_result" ? "result" : rawRole
    const content = message.slice(separator + 1).trimStart()
    return stepNestedLine(`${role.padEnd(11)}${content}`, 4)
}

function completedRunLines(includeSessions: boolean): TerminalLine[] {
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
        ...(includeSessions ? sessionLines(sessionId, "codex", "openai", "gpt-5.4-codex", reviewSessionMessages) : []),
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

function runningReleaseLines(): TerminalLine[] {
    return [
        line(`Run ${releaseRunId}`),
        line("publish-release · release-0.1 · attempt 1", 1),
        line("running · from 13:20", 1),
        blank(),
        line("Steps"),
        ...stepLines(1, "build-package", "custom", releaseStartedAt, "2026-08-13T11:20:03.400Z"),
        ...stepOutputLines(packageOutput),
        blank(),
        line("2. wait:approval:release-0.1", 1),
        stepNestedLine("event · running · from 13:20", 2),
        blank(),
        line("Artifacts"),
        line("None", 1)
    ]
}

function completedReleaseLines(): TerminalLine[] {
    return [
        ...runLines(releaseRunId, "publish-release", "release-0.1", 1, "succeeded", releaseStartedAt, releaseEndedAt),
        blank(),
        line("Steps"),
        ...stepLines(1, "build-package", "custom", releaseStartedAt, "2026-08-13T11:20:03.400Z"),
        ...stepOutputLines(packageOutput),
        blank(),
        ...stepLines(2, "wait:approval:release-0.1", "event", "2026-08-13T11:20:03.400Z", "2026-08-13T11:21:14.100Z"),
        blank(),
        stepNestedLine("Event approval:release-0.1", 2),
        ...stepOutputLines(approvalOutput),
        blank(),
        ...stepLines(3, "publish-package", "custom", "2026-08-13T11:21:14.100Z", releaseEndedAt),
        ...stepOutputLines(releaseOutput),
        blank(),
        line("Artifacts"),
        line("None", 1),
        ...outputLines(releaseOutput)
    ]
}

const releaseWatchChunks = [
    runningReleaseLines(),
    [line("Step wait:approval:release-0.1 (event): succeeded")],
    [line("Step publish-package (custom): running")],
    [line("Step publish-package (custom): succeeded")],
    [line(`Run ${releaseRunId}: succeeded`)],
    completedReleaseLines()
]

export const scenarios: Scenario[] = [
    {
        id: "workflows-list",
        group: "Workflows",
        label: "List workflows",
        command: "loopy workflows list",
        summary: "The CLI prints one registered workflow name per line.",
        note: "There is no heading or table in the current human-readable output.",
        delivery: "instant",
        lines: [line("dual-review"), line("hello-world"), line("review-pull-request")]
    },
    {
        id: "workflows-get",
        group: "Workflows",
        label: "Get workflow",
        command: "loopy workflows get dual-review",
        summary: "A workflow definition prints its input and output JSON Schemas.",
        note: "Schemas are pretty-printed JSON indented by two spaces.",
        delivery: "instant",
        lines: [
            line("Workflow: dual-review"),
            blank(),
            line("Input schema:"),
            ...jsonLines(workflowInputSchema, 1),
            blank(),
            line("Output schema:"),
            ...jsonLines(workflowOutputSchema, 1)
        ]
    },
    {
        id: "watch-success",
        group: "Live runs",
        label: "Run succeeds",
        command: `loopy runs watch ${runId} --include sessions`,
        summary: "Run watch prints each run or step update as it arrives and interleaves included session messages.",
        note: "There is no initial running run record, redraw, or workflow output at completion.",
        delivery: "streaming",
        lines: [
            line("Step prepare-context (llm): running"),
            ...contextSessionMessages.map((message) => line(message)),
            line("Step prepare-context (llm): succeeded"),
            line("Step review-changes (coding-agent): running"),
            ...reviewSessionMessages.map((message) => line(message)),
            line("Step review-changes (coding-agent): succeeded"),
            line("Step synthesize-verdict (llm): running"),
            ...verdictSessionMessages.map((message) => line(message)),
            line("Step synthesize-verdict (llm): succeeded"),
            line("Step artifact:review-summary (artifact): running"),
            line("Step artifact:review-summary (artifact): succeeded"),
            line(`Run ${runId}: succeeded`)
        ]
    },
    {
        id: "watch-failure",
        group: "Live runs",
        label: "Run fails",
        command: `loopy runs watch ${runId} --include sessions`,
        summary: "A failed step appends its error to the update before the failed run update is printed.",
        note: "The watch command reports failure through its exit code; it does not add a separate error line.",
        delivery: "streaming",
        lines: [
            line("Step collect-changes (custom): succeeded"),
            line("Step draft-notes (coding-agent): running"),
            ...failedReviewSessionMessages.map((message) => line(message)),
            line("Step draft-notes (coding-agent): failed: Repository checks failed"),
            line(`Run ${runId}: failed`)
        ]
    },
    {
        id: "get-watch-success",
        group: "Live runs",
        label: "Get and watch run",
        command: `loopy runs get ${releaseRunId} --watch`,
        summary: "Get with watch prints a running snapshot, tails later updates, then prints the completed snapshot.",
        note: "The initial and final snapshots arrive as blocks; only state changes are streamed between them.",
        delivery: "streaming",
        lines: releaseWatchChunks.flat(),
        chunks: releaseWatchChunks
    },
    {
        id: "runs-start",
        group: "Run control",
        label: "Start run",
        command: "loopy runs start review-pull-request --input input.json",
        summary: "Starting a run prints its identifier.",
        note: "The current human-readable response contains only the run ID.",
        delivery: "instant",
        lines: [line(runId)]
    },
    {
        id: "runs-resume",
        group: "Run control",
        label: "Resume run",
        command: `loopy runs resume ${runId}`,
        summary: "Resuming a run prints its identifier.",
        note: "The current human-readable response contains only the run ID.",
        delivery: "instant",
        lines: [line(runId)]
    },
    {
        id: "runs-rerun",
        group: "Run control",
        label: "Rerun from step",
        command: `loopy runs rerun ${runId} --from review-changes`,
        summary: "Rerunning from a step prints the new run identifier.",
        note: "The source run and step boundary appear in the command, not the response.",
        delivery: "instant",
        lines: [line(rerunId)]
    },
    {
        id: "run-details",
        group: "Snapshots",
        label: "Completed run",
        command: `loopy runs get ${runId}`,
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
        command: `loopy runs get ${runId} --include sessions`,
        summary: "Included session snapshots are nested beneath the steps that reference them.",
        note: "Included sessions nest client, provider, model, and aligned message roles beneath their owning step.",
        delivery: "instant",
        startAtTop: true,
        lines: completedRunLines(true)
    },
    {
        id: "string-output",
        group: "Snapshots",
        label: "String output",
        command: `loopy runs get ${stringRunId}`,
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
        command: "loopy runs list --limit 3",
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
        command: `loopy sessions get ${sessionId}`,
        summary: "A session snapshot prints identity, model metadata, timestamps, and its message history.",
        note: "Messages are indented two spaces beneath the Messages heading.",
        delivery: "instant",
        startAtTop: true,
        lines: [
            line(`Session: ${sessionId}`),
            line("Kind: coding-agent"),
            line("Client: codex"),
            line("Provider: openai"),
            line("Model: gpt-5.4-codex"),
            line("Status: succeeded"),
            line("Started: 2026-08-13T09:00:01.200Z"),
            line("Ended: 2026-08-13T09:00:42.000Z"),
            line("Messages:"),
            ...reviewSessionMessages.map((message) => line(message, 1))
        ]
    },
    {
        id: "sessions-watch",
        group: "Sessions",
        label: "Watch session",
        command: `loopy sessions watch ${sessionId}`,
        summary: "Session watch prints each message payload as it arrives.",
        note: "Existing history is replayed without a heading or indentation.",
        delivery: "streaming",
        lines: reviewSessionMessages.map((message) => line(message))
    },
    {
        id: "artifacts-get",
        group: "Artifacts",
        label: "Get artifact metadata",
        command: `loopy artifacts get ${artifactId}`,
        summary: "Artifact metadata is printed as six labeled fields.",
        note: "The current field order begins with the artifact ID and owning run.",
        delivery: "instant",
        lines: [
            line(`Artifact: ${artifactId}`),
            line(`Run: ${runId}`),
            line("Name: review-summary"),
            line("Kind: text"),
            line(`File: ${artifactFile}`),
            line("MIME type: text/markdown")
        ]
    },
    {
        id: "artifacts-read",
        group: "Artifacts",
        label: "Read artifact",
        command: `loopy artifacts read ${artifactId}`,
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
        command: `loopy artifacts copy ${artifactId} ./review-summary.md`,
        summary: "Copy confirms the artifact ID and resolved destination.",
        note: "The simulated command runs from /workspace, so the destination is absolute in the response.",
        delivery: "instant",
        lines: [line(`Copied ${artifactId} to /workspace/review-summary.md`)]
    },
    {
        id: "events-emit",
        group: "Events",
        label: "Emit event",
        command: `printf '{"ok":true}' | loopy events emit approval:release-0.1 --input -`,
        summary: "A successful event emission prints the event key.",
        note: "The current confirmation is prefixed with Event emitted.",
        delivery: "instant",
        lines: [line("Event emitted: approval:release-0.1")]
    },
    {
        id: "run-workflow",
        group: "Run control",
        label: "Run workflow",
        command: "loopy run hello-world",
        summary: "The attached run command prints the workflow's raw output JSON after completion.",
        note: "TTY and redirected sessions currently receive the same bare output.",
        delivery: "instant",
        lines: [line('"/tmp/loopy-hello-world-AbCdEf"')]
    }
]
