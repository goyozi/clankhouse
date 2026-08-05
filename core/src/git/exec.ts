import { spawn } from "node:child_process"

export async function execGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ProcessOutput> {
    return decodeOutput(await execGitRaw(cwd, args, env))
}

export async function mustGit(
    cwd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    input?: Buffer
): Promise<ProcessOutput> {
    return decodeOutput(await mustGitRaw(cwd, args, env, input))
}

export async function mustGitRaw(
    cwd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    input?: Buffer
): Promise<RawProcessOutput> {
    const result = await execGitRaw(cwd, args, env, input)
    if (result.exitCode !== 0) throw gitFailure(cwd, args, decodeOutput(result))
    return result
}

export function execGitRaw(
    cwd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    input?: Buffer
): Promise<RawProcessOutput> {
    return new Promise((resolve) => {
        const child = spawn("git", args, { cwd, env: env === undefined ? process.env : { ...process.env, ...env } })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let stdinError: Error | undefined
        let settled = false
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
        child.stdin.on("error", (error) => {
            stdinError = error
        })
        child.on("error", (error) => {
            if (settled) return
            settled = true
            resolve({ exitCode: 1, stdout: Buffer.concat(stdout), stderr: Buffer.from(error.message) })
        })
        child.on("close", (code) => {
            if (settled) return
            settled = true
            const capturedStderr = Buffer.concat(stderr)
            const stdinFailure = stdinError === undefined ? [] : [Buffer.from(stdinError.message)]
            const stdinSeparator =
                stdinError !== undefined && capturedStderr.length > 0 && capturedStderr.at(-1) !== 0x0a
                    ? [Buffer.from("\n")]
                    : []
            resolve({
                exitCode: code === 0 && stdinError !== undefined ? 1 : (code ?? 1),
                stdout: Buffer.concat(stdout),
                stderr: Buffer.concat([capturedStderr, ...stdinSeparator, ...stdinFailure])
            })
        })
        child.stdin.end(input)
    })
}

function decodeOutput(result: RawProcessOutput): ProcessOutput {
    return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") }
}

function gitFailure(cwd: string, args: string[], result: ProcessOutput): Error {
    return new Error(
        `git ${args.join(" ")} failed in ${cwd} (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`
    )
}

export type RawProcessOutput = {
    exitCode: number
    stdout: Buffer
    stderr: Buffer
}

export type ProcessOutput = {
    exitCode: number
    stdout: string
    stderr: string
}
