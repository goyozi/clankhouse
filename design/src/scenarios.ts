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
const prepareStepId = "sP7mN2qR9vK4xD1cL8wF5"
const reviewStepId = "sC3tH8bY1nM6pQ4vR9kD2"
const verdictStepId = "sV6xA1jF8mT3qL9cN4wP7"
const artifactStepId = "sA9kR4mT2vC7xN1qP6wD8"
const startedAt = "2026-08-13T09:00:00.000Z"
const verdictEndedAt = "2026-08-13T09:00:56.000Z"
const endedAt = "2026-08-13T09:00:56.200Z"
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
    id: string,
    name: string,
    started: string,
    ended: string,
    details: {
        session?: string
        artifact?: string
        output?: unknown
    } = {}
): TerminalLine[] {
    return [
        line(`${seq}. ${key} (${kind})`, 1),
        line(`ID: ${id}`, 1),
        line(`Name: ${name}`, 1),
        line("Status: succeeded", 1),
        line(`Started: ${started}`, 1),
        line(`Ended: ${ended}`, 1),
        ...(details.session === undefined ? [] : [line(`Session: ${details.session}`, 1)]),
        ...(details.artifact === undefined ? [] : [line(`Artifact: ${details.artifact}`, 1)]),
        ...(details.output === undefined ? [] : [line("Output:", 1), ...jsonLines(details.output, 2)])
    ]
}

function sessionLines(
    id: string,
    kind: string,
    provider: string,
    model: string,
    started: string,
    ended: string,
    messages: string[]
): TerminalLine[] {
    return [
        line(`Session: ${id}`, 2),
        line(`Kind: ${kind}`, 2),
        line(`Provider: ${provider}`, 2),
        line(`Model: ${model}`, 2),
        line("Status: succeeded", 2),
        line(`Started: ${started}`, 2),
        line(`Ended: ${ended}`, 2),
        line("Messages:", 2),
        ...messages.map((message) => line(message, 3))
    ]
}

function completedRunLines(includeSessions: boolean): TerminalLine[] {
    return [
        line(`Run: ${runId}`),
        line("Workflow: review-pull-request"),
        line("Key: pr-482"),
        line("Attempt: 1"),
        line("Status: succeeded"),
        line(`Started: ${startedAt}`),
        line(`Ended: ${endedAt}`),
        ...outputLines(completedOutput),
        blank(),
        line("Steps:"),
        ...stepLines(
            1,
            "prepare-context",
            "llm",
            prepareStepId,
            "prepare-context",
            startedAt,
            "2026-08-13T09:00:01.200Z",
            { session: contextSessionId, output: prepareOutput }
        ),
        ...(includeSessions
            ? sessionLines(
                  contextSessionId,
                  "llm",
                  "openai",
                  "gpt-5.4",
                  startedAt,
                  "2026-08-13T09:00:01.200Z",
                  contextSessionMessages
              )
            : []),
        ...stepLines(
            2,
            "review-changes",
            "agent",
            reviewStepId,
            "review-changes",
            "2026-08-13T09:00:01.200Z",
            "2026-08-13T09:00:42.000Z",
            { session: sessionId, output: reviewOutput }
        ),
        ...(includeSessions
            ? sessionLines(
                  sessionId,
                  "coding-agent",
                  "openai",
                  "gpt-5.4-codex",
                  "2026-08-13T09:00:01.200Z",
                  "2026-08-13T09:00:42.000Z",
                  reviewSessionMessages
              )
            : []),
        ...stepLines(
            3,
            "synthesize-verdict",
            "llm",
            verdictStepId,
            "synthesize-verdict",
            "2026-08-13T09:00:42.000Z",
            verdictEndedAt,
            { session: verdictSessionId, output: verdictOutput }
        ),
        ...(includeSessions
            ? sessionLines(
                  verdictSessionId,
                  "llm",
                  "openai",
                  "gpt-5.4",
                  "2026-08-13T09:00:42.000Z",
                  verdictEndedAt,
                  verdictSessionMessages
              )
            : []),
        ...stepLines(
            4,
            "artifact:review-summary",
            "artifact",
            artifactStepId,
            "artifact:review-summary",
            verdictEndedAt,
            endedAt,
            { artifact: artifactId, output: artifactOutput }
        ),
        ...artifactLines(completedArtifacts)
    ]
}

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
            line("Step review-changes (agent): running"),
            ...reviewSessionMessages.map((message) => line(message)),
            line("Step review-changes (agent): succeeded"),
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
            line("Step draft-notes (agent): running"),
            ...failedReviewSessionMessages.map((message) => line(message)),
            line("Step draft-notes (agent): failed: Repository checks failed"),
            line(`Run ${runId}: failed`)
        ]
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
        summary: "A run snapshot prints metadata, pretty JSON output, detailed steps, and artifacts in that order.",
        note: "Every step uses a multi-line labeled record in the current output.",
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
        note: "Session fields are indented four spaces and messages six spaces within the run snapshot.",
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
            line(`Run: ${stringRunId}`),
            line("Workflow: release-notes"),
            line("Key: v0.1.0"),
            line("Attempt: 1"),
            line("Status: succeeded"),
            line("Started: 2026-08-13T10:15:00.000Z"),
            line("Ended: 2026-08-13T10:15:04.800Z"),
            ...outputLines("Release notes are ready for review."),
            blank(),
            line("Steps:"),
            ...stepLines(
                1,
                "collect-changes",
                "custom",
                "sG2mP8vD4xN7qL1cR6wK9",
                "collect-changes",
                "2026-08-13T10:15:00.000Z",
                "2026-08-13T10:15:00.400Z",
                { output: { count: 3 } }
            ),
            ...stepLines(
                2,
                "draft-notes",
                "llm",
                "sN5tA9jH3mQ8vF2cL7xR1",
                "draft-notes",
                "2026-08-13T10:15:00.400Z",
                "2026-08-13T10:15:04.800Z",
                { session: draftSessionId, output: "Release notes are ready for review." }
            ),
            blank(),
            line("Artifacts:"),
            line("None", 1)
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
                [
                    "cJ6yF1bL8qS3wG9nE2zM5",
                    "publish-release",
                    "release-0.1",
                    "1",
                    "running",
                    "2026-08-13T11:20:00.000Z",
                    "-"
                ],
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
        note: "Without an --after-message cursor, existing history is replayed without a heading or indentation.",
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
