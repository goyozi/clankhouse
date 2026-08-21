import { PassThrough, Readable } from "node:stream"
import { timestampFromDate } from "@bufbuild/protobuf/wkt"
import type { SessionRecorder } from "@loopy/core/ai/sessions"
import { LoopyError } from "@loopy/core/errors"
import type { Loopy } from "@loopy/core/loopy"
import { listen, type LoopyServer } from "@loopy/server"
import { gate, tempLoopy, waitForRun } from "@loopy/test-utils"
import { expect, onTestFinished, test } from "vitest"
import * as z from "zod"
import { runCli } from "../../../src"
import { executionTiming } from "../../../src/output"

async function testServer(loopy: Loopy): Promise<LoopyServer> {
    const server = await listen(loopy, { port: 0 })
    onTestFinished(() => server.close())
    return server
}

function serverEnv(server: LoopyServer): NodeJS.ProcessEnv {
    return {
        ...process.env,
        LOOPY_SERVER_URL: server.url,
        LOOPY_API_KEY: server.apiKey
    }
}

async function runCliCommand(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const chunks: Buffer[] = []
    stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    const code = await runCli(args, {
        stdin: Readable.from([]),
        stdout,
        stderr,
        env,
        cwd: process.cwd()
    })
    expect(code).toBe(0)
    return Buffer.concat(chunks).toString("utf8")
}

function startCliCommand(
    args: string[],
    env: NodeJS.ProcessEnv
): {
    done: Promise<number>
    stdout: () => string
    stderr: () => string
} {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    stdout.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)))
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
    return {
        done: runCli(args, {
            stdin: Readable.from([]),
            stdout,
            stderr,
            env,
            cwd: process.cwd()
        }),
        stdout: () => Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: () => Buffer.concat(stderrChunks).toString("utf8")
    }
}

async function waitForOutput(output: () => string, text: string): Promise<void> {
    for (let attempt = 0; attempt < 2000; attempt++) {
        if (output().includes(text)) return
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`CLI output did not contain: ${text}\n\n${output()}`)
}

function duration(startedAt: Date, endedAt: Date | undefined): string {
    if (endedAt === undefined) throw new Error("Expected execution to have ended")
    const value = executionTiming(timestampFromDate(startedAt), timestampFromDate(endedAt))
    if (value === undefined) throw new Error("Expected execution timing")
    return value
}

function clock(date: Date): string {
    return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`
}

function minute(date: Date): string {
    return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
}

function twoDigits(value: number): string {
    return String(value).padStart(2, "0")
}

test("runs get command output matches designs", async () => {
    // given completed detailed, empty, and failed workflow runs
    const { loopy } = tempLoopy()
    let sessionId = ""
    let emptySessionId = ""
    loopy.registerWorkflow(
        "compact-snapshot",
        {
            input: z.null(),
            output: z.object({ verdict: z.string(), artifactId: z.string() }),
            key: () => "compact-key"
        },
        async () => {
            const verdict = await loopy.engine.executeStep({
                kind: "agent",
                name: "review",
                schema: z.string(),
                execute: async (handle) => {
                    const session = loopy.sessions.create({
                        kind: "coding-agent",
                        client: "fixture-agent",
                        provider: "fixture-provider",
                        model: "fixture-model"
                    })
                    sessionId = session.id
                    handle.set("session_id", session.id)
                    handle.set("snapshot_ref", "refs/loopy/review")
                    session.addMessage("user", "Review this\n\ncarefully")
                    session.addToolCall({
                        id: "call-1",
                        name: "read",
                        source: { kind: "native" },
                        input: { path: "README.md" },
                        common: { name: "file.read", path: "README.md" }
                    })
                    session.addToolResult({ toolCallId: "call-1", status: "succeeded", output: { lines: 2 } })
                    session.addMessage("assistant", "approve")
                    session.succeed()
                    return "approve"
                }
            })
            await loopy.engine.executeStep({
                kind: "event",
                name: "approval",
                schema: z.object({ approved: z.boolean() }),
                execute: async (handle) => {
                    handle.set("event_key", "approval:compact-key")
                    return { approved: true }
                }
            })
            await loopy.engine.executeStep({
                kind: "llm",
                name: "empty-session",
                schema: z.void(),
                execute: async (handle) => {
                    const session = loopy.sessions.create({
                        kind: "llm",
                        client: "fixture-llm",
                        provider: "fixture-provider",
                        model: "fixture-model"
                    })
                    emptySessionId = session.id
                    handle.set("session_id", session.id)
                    session.succeed()
                }
            })
            const artifact = await loopy.artifacts.writeText("summary", verdict, "text/plain")
            return { verdict, artifactId: artifact.id }
        }
    )
    loopy.registerWorkflow(
        "empty-snapshot",
        { input: z.null(), output: z.string(), key: () => "empty-key" },
        async () => "ready"
    )
    loopy.registerWorkflow(
        "failed-snapshot",
        { input: z.null(), output: z.void(), key: () => "failed-key" },
        async () => {
            await loopy.step("explode", z.void(), async () => {
                throw new LoopyError("event_sources_empty", "coded failure")
            })
        }
    )
    const detailedRunId = loopy.start("compact-snapshot", null)
    const emptyRunId = loopy.start("empty-snapshot", null)
    const failedRunId = loopy.start("failed-snapshot", null)
    const [detailedRun, emptyRun, failedRun] = await Promise.all([
        waitForRun(loopy, detailedRunId),
        waitForRun(loopy, emptyRunId),
        waitForRun(loopy, failedRunId)
    ])
    const review = detailedRun.steps.find((step) => step.key === "review")!
    const approval = detailedRun.steps.find((step) => step.key === "approval")!
    const emptySession = detailedRun.steps.find((step) => step.key === "empty-session")!
    const artifactStep = detailedRun.steps.find((step) => step.kind === "artifact")!
    const artifact = detailedRun.artifacts[0]!
    const failedStep = failedRun.steps[0]!
    const env = serverEnv(await testServer(loopy))

    // when the runs are requested in compact and expanded human-readable forms
    const detailed = await runCliCommand(["runs", "get", detailedRunId, "--include", "sessions"], env)
    const expanded = await runCliCommand(
        ["runs", "get", detailedRunId, "--include", "sessions", "--include", "tool-io"],
        env
    )
    const implied = await runCliCommand(["runs", "get", detailedRunId, "--include", "tool-io"], env)
    const all = await runCliCommand(["runs", "get", detailedRunId, "--include", "all"], env)
    const verbose = await runCliCommand(["runs", "get", detailedRunId, "--verbose"], env)
    const empty = await runCliCommand(["runs", "get", emptyRunId], env)
    const failed = await runCliCommand(["runs", "get", failedRunId], env)

    // then the complete outputs match the compact run designs
    expect(detailed).toBe(`Run ${detailedRunId}
  compact-snapshot · compact-key · attempt 1
  succeeded · ${duration(detailedRun.startedAt, detailedRun.endedAt)}

Steps
  ${review.seq + 1}. review
     coding-agent · succeeded · ${duration(review.startedAt, review.endedAt)}

     Session ${sessionId}
       fixture-agent · fixture-provider/fixture-model

       Messages
         user       Review this

                    carefully
         tool       read README.md
         assistant  approve

     Snapshot refs/loopy/review

     Output
       "approve"

  ${approval.seq + 1}. approval
     event · succeeded · ${duration(approval.startedAt, approval.endedAt)}

     Event approval:compact-key

     Output
       {
         "approved": true
       }

  ${emptySession.seq + 1}. empty-session
     llm · succeeded · ${duration(emptySession.startedAt, emptySession.endedAt)}

     Session ${emptySessionId}
       fixture-llm · fixture-provider/fixture-model

       Messages
         None

  ${artifactStep.seq + 1}. artifact:summary
     artifact · succeeded · ${duration(artifactStep.startedAt, artifactStep.endedAt)}

     Artifact ${artifact.id}

     Output
       {
         "id": "${artifact.id}",
         "runId": "${detailedRunId}",
         "name": "summary",
         "file": "${artifact.file}",
         "kind": "text",
         "mimeType": "text/plain"
       }

Artifacts
  ${artifact.id}: summary (text, text/plain)

Output
  {
    "verdict": "approve",
    "artifactId": "${artifact.id}"
  }
`)

    // and tool I/O implies sessions while all expanded spellings produce the same complete details
    expect(expanded).toContain("         tool       read README.md")
    expect(expanded).toContain('         input      {"id":"call-1","tool":"read","input":{"path":"README.md"}}')
    expect(expanded).toContain('         result     {"toolUseId":"call-1","status":"succeeded","content":{"lines":2}}')
    expect(implied).toBe(expanded)
    expect(all).toBe(expanded)
    expect(verbose).toBe(expanded)

    // and empty collections, string output, and failures retain explicit compact representations
    expect(empty).toBe(`Run ${emptyRunId}
  empty-snapshot · empty-key · attempt 1
  succeeded · ${duration(emptyRun.startedAt, emptyRun.endedAt)}

Steps
  None

Artifacts
  None

Output
  "ready"
`)
    expect(failed).toBe(`Run ${failedRunId}
  failed-snapshot · failed-key · attempt 1
  failed · ${duration(failedRun.startedAt, failedRun.endedAt)}
  Error code event_sources_empty
  Error coded failure

Steps
  ${failedStep.seq + 1}. explode
     custom · failed · ${duration(failedStep.startedAt, failedStep.endedAt)}

     Error code event_sources_empty
     Error coded failure

Artifacts
  None
`)
})

test("runs get command omits an empty active step count", async () => {
    // given a running workflow with no active step
    const { loopy } = tempLoopy()
    const entered = gate()
    const finish = gate()
    onTestFinished(finish.release)
    loopy.registerWorkflow("step-gap", { input: z.null(), output: z.void(), key: () => "step-gap" }, async () => {
        entered.release()
        await finish.released
    })
    const runId = loopy.start("step-gap", null)
    await entered.released
    const run = await loopy.runs.get(runId)

    // when the running workflow is rendered
    const output = await runCliCommand(["runs", "get", runId], serverEnv(await testServer(loopy)))

    // then the header does not report zero active steps
    expect(output).toBe(`Run ${runId}
  step-gap · step-gap · attempt 1
  running · from ${minute(run.startedAt)}

Steps
  None

Artifacts
  None
`)
})

test("runs watch command output matches scoped activity designs", async () => {
    // given a real run with two active agent steps and externally controlled sessions
    const { loopy } = tempLoopy()
    const sessionsReady = gate()
    const firstDone = gate()
    const secondDone = gate()
    let firstSession: SessionRecorder | undefined
    let secondSession: SessionRecorder | undefined
    loopy.registerWorkflow(
        "scoped-activity",
        {
            input: z.null(),
            output: z.object({ verdict: z.string() }),
            key: () => "scoped-key"
        },
        async () => {
            const [first, second] = await Promise.all([
                loopy.engine.executeStep({
                    kind: "agent",
                    name: "code-review",
                    schema: z.object({ verdict: z.string() }),
                    execute: async (handle) => {
                        const session = loopy.sessions.create({
                            kind: "coding-agent",
                            client: "fixture-review",
                            provider: "fixture",
                            model: "review-model"
                        })
                        firstSession = session
                        handle.set("session_id", session.id)
                        if (secondSession !== undefined) sessionsReady.release()
                        await firstDone.released
                        session.succeed()
                        return { verdict: "approve" }
                    }
                }),
                loopy.engine.executeStep({
                    kind: "agent",
                    name: "test-review",
                    schema: z.object({ tests: z.number() }),
                    execute: async (handle) => {
                        const session = loopy.sessions.create({
                            kind: "coding-agent",
                            client: "fixture-test",
                            provider: "fixture",
                            model: "test-model"
                        })
                        secondSession = session
                        handle.set("session_id", session.id)
                        if (firstSession !== undefined) sessionsReady.release()
                        await secondDone.released
                        session.succeed()
                        return { tests: 38 }
                    }
                })
            ])
            return { verdict: first.verdict === "approve" && second.tests === 38 ? "approve" : "reject" }
        }
    )
    onTestFinished(() => {
        firstDone.release()
        secondDone.release()
    })
    const runId = loopy.start("scoped-activity", null)
    await sessionsReady.released
    const env = serverEnv(await testServer(loopy))

    // when messages and completions interleave while compact and verbose human watches are running
    const watch = startCliCommand(["runs", "watch", runId, "--include", "sessions"], env)
    const verboseWatch = startCliCommand(["runs", "watch", runId, "--verbose"], env)
    await waitForOutput(watch.stdout, "test-review\n     coding-agent · running")
    await waitForOutput(verboseWatch.stdout, "test-review\n     coding-agent · running")
    firstSession!.addMessage("user", "Review this\n\ncarefully")
    await waitForOutput(watch.stdout, "Review this")
    firstSession!.addMessage("assistant", "The API is sound.\nNo blockers.")
    await waitForOutput(watch.stdout, "No blockers.")
    secondSession!.addMessage("user", "Run the focused tests.")
    secondSession!.addMessage("assistant", "Starting the suite.")
    await waitForOutput(watch.stdout, "Starting the suite.")
    firstSession!.addToolCall({
        id: "call-1",
        name: "read",
        source: { kind: "native" },
        input: { path: "README.md" },
        common: { name: "file.read", path: "README.md" }
    })
    firstSession!.addToolResult({ toolCallId: "call-1", status: "succeeded", output: { lines: 2 } })
    firstSession!.addMessage("assistant", "approve")
    await waitForOutput(watch.stdout, "assistant  approve")
    firstDone.release()
    await waitForOutput(watch.stdout, 'Output {"verdict":"approve"}')
    secondSession!.addMessage("assistant", "All focused tests pass.")
    await waitForOutput(watch.stdout, "All focused tests pass.")
    secondDone.release()
    const code = await watch.done
    const verboseCode = await verboseWatch.done
    const run = await loopy.runs.get(runId)
    const firstStep = run.steps.find((step) => step.key === "code-review")!
    const secondStep = run.steps.find((step) => step.key === "test-review")!
    const storedFirst = await loopy.sessions.get(firstSession!.id)
    const storedSecond = await loopy.sessions.get(secondSession!.id)

    // then the exact output uses owner blocks, aligned multiline messages, and compact terminal details
    expect(code).toBe(0)
    expect(watch.stderr()).toBe("")
    expect(watch.stdout()).toBe(`Run ${runId}
  scoped-activity · scoped-key · attempt 1
  running · from ${minute(run.startedAt)}

Activity
  ${clock(firstStep.startedAt)}  ${firstStep.seq + 1}. code-review
     coding-agent · running

  ${clock(secondStep.startedAt)}  ${secondStep.seq + 1}. test-review
     coding-agent · running

  ${clock(storedFirst.messages[0]!.createdAt)}  ${firstStep.seq + 1}. code-review
     Session ${storedFirst.id} · fixture-review · fixture/review-model
       user       Review this

                  carefully
       assistant  The API is sound.
                  No blockers.

  ${clock(storedSecond.messages[0]!.createdAt)}  ${secondStep.seq + 1}. test-review
     Session ${storedSecond.id} · fixture-test · fixture/test-model
       user       Run the focused tests.
       assistant  Starting the suite.

  ${clock(storedFirst.messages[2]!.createdAt)}  ${firstStep.seq + 1}. code-review
     Session (continued)
       tool       read README.md
       assistant  approve
     coding-agent · succeeded · ${duration(firstStep.startedAt, firstStep.endedAt)}
     Output {"verdict":"approve"}

  ${clock(storedSecond.messages[2]!.createdAt)}  ${secondStep.seq + 1}. test-review
     Session (continued)
       assistant  All focused tests pass.
     coding-agent · succeeded · ${duration(secondStep.startedAt, secondStep.endedAt)}
     Output {"tests":38}

  ${clock(run.endedAt!)}  Run ${runId}
     succeeded · ${duration(run.startedAt, run.endedAt)}
     Output {"verdict":"approve"}
`)

    // and verbose implicitly follows sessions and includes their complete tool I/O
    expect(verboseCode).toBe(0)
    expect(verboseWatch.stderr()).toBe("")
    expect(verboseWatch.stdout()).toContain("       tool       read README.md")
    expect(verboseWatch.stdout()).toContain(
        '       input      {"id":"call-1","tool":"read","input":{"path":"README.md"}}'
    )
    expect(verboseWatch.stdout()).toContain(
        '       result     {"toolUseId":"call-1","status":"succeeded","content":{"lines":2}}'
    )
})

test("runs watch command output scopes step and run failures", async () => {
    // given a watched run parked inside a step that will fail
    const { loopy } = tempLoopy()
    const entered = gate()
    const fail = gate()
    onTestFinished(fail.release)
    loopy.registerWorkflow(
        "failed-activity",
        { input: z.null(), output: z.void(), key: () => "failed-key" },
        async () => {
            await loopy.step("draft-notes", z.void(), async () => {
                entered.release()
                await fail.released
                throw new LoopyError("event_sources_empty", "Repository checks failed")
            })
        }
    )
    const runId = loopy.start("failed-activity", null)
    await entered.released
    const watch = startCliCommand(["runs", "watch", runId], serverEnv(await testServer(loopy)))

    // when the parked step is allowed to fail
    await waitForOutput(watch.stdout, "custom · running")
    fail.release()
    const code = await watch.done
    const run = await loopy.runs.get(runId)
    const step = run.steps[0]!

    // then both failure scopes are appended and the command exits unsuccessfully
    expect(code).toBe(1)
    expect(watch.stderr()).toBe("")
    expect(watch.stdout()).toBe(`Run ${runId}
  failed-activity · failed-key · attempt 1
  running · from ${minute(run.startedAt)}

Activity
  ${clock(step.startedAt)}  ${step.seq + 1}. draft-notes
     custom · running
     custom · failed · ${duration(step.startedAt, step.endedAt)}
     Error Repository checks failed

  ${clock(run.endedAt!)}  Run ${runId}
     failed · ${duration(run.startedAt, run.endedAt)}
     Error Repository checks failed
`)
})

test("runs get --watch command output matches snapshot and scoped update designs", async () => {
    // given a running agent step with included multiline session history
    const { loopy } = tempLoopy()
    const ready = gate()
    const finish = gate()
    let session: SessionRecorder | undefined
    onTestFinished(finish.release)
    loopy.registerWorkflow(
        "snapshot-activity",
        { input: z.null(), output: z.string(), key: () => "snapshot-key" },
        async () =>
            loopy.engine.executeStep({
                kind: "agent",
                name: "review",
                schema: z.string(),
                execute: async (handle) => {
                    session = loopy.sessions.create({
                        kind: "coding-agent",
                        client: "fixture-agent",
                        provider: "fixture",
                        model: "fixture-model"
                    })
                    handle.set("session_id", session.id)
                    session.addMessage("user", "Review this\n\ncarefully")
                    ready.release()
                    await finish.released
                    session.succeed()
                    return "approve"
                }
            })
    )
    const runId = loopy.start("snapshot-activity", null)
    await ready.released
    const watch = startCliCommand(
        ["runs", "get", runId, "--include", "sessions", "--watch"],
        serverEnv(await testServer(loopy))
    )

    // when a later assistant message completes the snapshotted step and run
    await waitForOutput(watch.stdout, "Updates")
    session!.addMessage("assistant", "approve\nwith no blockers")
    await waitForOutput(watch.stdout, "with no blockers")
    finish.release()
    const code = await watch.done
    const run = await loopy.runs.get(runId)
    const step = run.steps[0]!
    const storedSession = await loopy.sessions.get(session!.id)

    // then the initial active snapshot is followed by updates without a repeated final snapshot
    expect(code).toBe(0)
    expect(watch.stderr()).toBe("")
    expect(watch.stdout()).toBe(`Run ${runId}
  snapshot-activity · snapshot-key · attempt 1
  running · from ${minute(run.startedAt)} · 1 active step

Steps
  ${step.seq + 1}. review
     coding-agent · running · from ${minute(step.startedAt)}

     Session ${storedSession.id}
       fixture-agent · fixture/fixture-model

       Messages
         user       Review this

                    carefully

Artifacts
  None

Updates
  ${clock(storedSession.messages[1]!.createdAt)}  ${step.seq + 1}. review
     Session (continued)
       assistant  approve
                  with no blockers
     coding-agent · succeeded · ${duration(step.startedAt, step.endedAt)}
     Output "approve"

  ${clock(run.endedAt!)}  Run ${runId}
     succeeded · ${duration(run.startedAt, run.endedAt)}
     Output "approve"
`)
})
