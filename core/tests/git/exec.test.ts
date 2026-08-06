import { expect, test } from "vitest"
import { execGitRaw } from "../../src/git/exec"

test("execGitRaw reports stdin EPIPE instead of crashing the process", async () => {
    // given more stdin than a Git command that exits immediately can consume
    const input = Buffer.alloc(8 * 1024 * 1024)

    // when raw Git execution writes that input to the closed pipe
    const result = await execGitRaw(process.cwd(), ["--version"], undefined, input)

    // then the stream failure is returned as process output
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString("utf8")).toContain("EPIPE")
})
