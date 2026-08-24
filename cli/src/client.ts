import { lstat, readFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createClient, type Client, type Interceptor } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-node"
import { ClankHouseService } from "@clankhouse/protocol"
import { CliError } from "./errors.js"

export type ClankHouseClient = Client<typeof ClankHouseService>

export type ConnectionOptions = {
    server?: string
    apiKey?: string
    env: NodeJS.ProcessEnv
}

export async function connect(options: ConnectionOptions): Promise<ClankHouseClient> {
    const baseUrl = resolveServer(options.server ?? options.env.CLANK_SERVER_URL)
    const apiKey = await resolveApiKey(options.apiKey, options.env)
    const bearer: Interceptor = (next) => async (request) => {
        request.header.set("authorization", `Bearer ${apiKey}`)
        return next(request)
    }
    return createClient(
        ClankHouseService,
        createConnectTransport({
            httpVersion: "1.1",
            baseUrl,
            interceptors: [bearer]
        })
    )
}

function resolveServer(value: string | undefined): string {
    const candidate = value === undefined || value.length === 0 ? "http://127.0.0.1:7331" : value
    let url: URL
    try {
        url = new URL(candidate)
    } catch (cause) {
        throw new CliError("configuration", `Invalid ClankHouse server URL: ${candidate}`, { cause })
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new CliError("configuration", "ClankHouse server URL must use http or https")
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        throw new CliError("configuration", "ClankHouse server URL must use https for non-loopback hosts")
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new CliError("configuration", "ClankHouse server URL must not contain credentials")
    }
    return url.toString().replace(/\/$/, "")
}

function isLoopbackHost(hostname: string): boolean {
    const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
    if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true
    const octets = host.split(".")
    return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet))
}

async function resolveApiKey(explicit: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
    const configured = explicit ?? env.CLANK_API_KEY
    if (configured !== undefined) {
        if (configured.length === 0) throw new CliError("configuration", "ClankHouse API key must not be empty")
        return configured
    }

    const home = env.HOME ?? env.USERPROFILE ?? os.homedir()
    const clankhouseDir = env.CLANKHOUSE_DIR ?? path.join(home, ".clankhouse")
    const file = path.join(clankhouseDir, "credentials.json")
    let text: string
    try {
        const stat = await lstat(file)
        if (!stat.isFile())
            throw new CliError("configuration", `ClankHouse credentials are not a regular file: ${file}`)
        text = await readFile(file, "utf8")
    } catch (cause) {
        if (cause instanceof CliError) throw cause
        throw new CliError("configuration", `Unable to read ClankHouse credentials from ${file}`, { cause })
    }
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch (cause) {
        throw new CliError("configuration", `ClankHouse credentials are malformed: ${file}`, { cause })
    }
    if (!isCredentials(value)) {
        throw new CliError("configuration", `ClankHouse credentials are malformed: ${file}`)
    }
    return value.apiKey
}

function isCredentials(value: unknown): value is { version: 1; apiKey: string } {
    if (typeof value !== "object" || value === null) return false
    const candidate = value as Record<string, unknown>
    if (candidate.version !== 1 || typeof candidate.apiKey !== "string") return false
    if (!/^[A-Za-z0-9_-]{43}$/.test(candidate.apiKey)) return false
    return Buffer.from(candidate.apiKey, "base64url").byteLength === 32
}
