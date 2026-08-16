import { PassThrough, Readable } from "node:stream"
import { timestampFromDate } from "@bufbuild/protobuf/wkt"
import { LoopyError } from "@loopy/core/errors"
import type { Loopy } from "@loopy/core/loopy"
import { listen, type LoopyServer } from "@loopy/server"
import { tempLoopy, waitForRun } from "@loopy/test-utils"
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

function duration(startedAt: Date, endedAt: Date | undefined): string {
    if (endedAt === undefined) throw new Error("Expected execution to have ended")
    const value = executionTiming(timestampFromDate(startedAt), timestampFromDate(endedAt))
    if (value === undefined) throw new Error("Expected execution timing")
    return value
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
                        input: { path: "README.md" }
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

    // when the runs are requested in human-readable form
    const detailed = await runCliCommand(["runs", "get", detailedRunId, "--include", "sessions"], env)
    const empty = await runCliCommand(["runs", "get", emptyRunId], env)
    const failed = await runCliCommand(["runs", "get", failedRunId], env)

    // then the complete outputs match the compact run designs
    expect(detailed).toBe(`Run ${detailedRunId}
  compact-snapshot · compact-key · attempt 1
  succeeded · ${duration(detailedRun.startedAt, detailedRun.endedAt)}

Steps
  ${review.seq}. review
     coding-agent · succeeded · ${duration(review.startedAt, review.endedAt)}

     Session ${sessionId}
       fixture-agent · fixture-provider/fixture-model

       Messages
         user       Review this

                    carefully
         tool       {"id":"call-1","tool":"read","input":{"path":"README.md"}}
         result     {"toolUseId":"call-1","status":"succeeded","content":{"lines":2}}
         assistant  approve

     Snapshot refs/loopy/review

     Output
       "approve"

  ${approval.seq}. approval
     event · succeeded · ${duration(approval.startedAt, approval.endedAt)}

     Event approval:compact-key

     Output
       {
         "approved": true
       }

  ${emptySession.seq}. empty-session
     llm · succeeded · ${duration(emptySession.startedAt, emptySession.endedAt)}

     Session ${emptySessionId}
       fixture-llm · fixture-provider/fixture-model

       Messages
         None

  ${artifactStep.seq}. artifact:summary
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
  ${failedStep.seq}. explode
     custom · failed · ${duration(failedStep.startedAt, failedStep.endedAt)}

     Error code event_sources_empty
     Error coded failure

Artifacts
  None
`)
})
