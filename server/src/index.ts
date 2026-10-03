import * as http from "node:http"
import * as https from "node:https"
import { Code, ConnectError } from "@connectrpc/connect"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { clankhouse as defaultClankHouse, type RecoverResult } from "@clankhouse/core"
import { validateGcOptions, type ClankHouse, type GcOptions } from "@clankhouse/core/clankhouse"
import { ClankHouseService } from "@clankhouse/protocol"
import { bearerAuth } from "./auth.js"
import { resolveCredentials } from "./credentials.js"
import { listen as bindServer } from "./listen.js"
import { clankhouseService } from "./service.js"

const IDLE_SWEEP_MS = 10
const CLOSE_GRACE_MS = 1000
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000

export type ServeOptions = {
    host?: string
    port?: number
    tls?: https.ServerOptions
    onError?: (error: Error) => void
    recover?: boolean
    gc?: false | GcOptions
}

export type ClankHouseServer = {
    host: string
    port: number
    url: string
    readonly apiKey: string
    credentialsFile: string
    recovered?: RecoverResult
    close(): Promise<void>
}

/**
 * Starts a ClankHouse server and takes full ownership of the clankhouse instance:
 * - handles SIGINT and SIGTERM
 * - recovers interrupted runs once the listener is bound, unless `recover` is `false`
 * - runs GC in the background after recovery and then every 24 hours, unless `gc` is `false`
 * - closes ClankHouse on shutdown and on startup failure
 * - terminates the process with the received signal after cleanup
 *
 * Workflows must be registered before calling `serve`; interrupted runs of workflows registered later
 * are skipped as `not_registered`.
 *
 * @see listen
 */
export async function serve(
    clankhouse: ClankHouse = defaultClankHouse(),
    options: ServeOptions = {}
): Promise<ClankHouseServer> {
    const reportError = options.onError ?? reportServerError
    const gcOptions = options.gc ?? {}
    let server: ClankHouseServer | undefined
    try {
        if (gcOptions !== false) validateGcOptions(gcOptions)
        server = await listen(clankhouse, options)
        if (options.recover ?? true) {
            server.recovered = clankhouse.recover()
            for (const failure of server.recovered.failed) reportError(failure.error)
        }
    } catch (error) {
        await server?.close().catch(reportError)
        clankhouse.close()
        throw error
    }

    const stopGc = gcOptions === false ? undefined : scheduleGc(clankhouse, gcOptions, reportError)
    const closeListener = server.close
    let closePromise: Promise<void> | undefined
    const removeSignalHandlers = () => {
        process.off("SIGINT", handleSignal)
        process.off("SIGTERM", handleSignal)
    }
    const close = () => {
        closePromise ??= (async () => {
            const gcStopped = stopGc?.()
            try {
                await closeListener()
            } finally {
                removeSignalHandlers()
                await gcStopped
                clankhouse.close()
            }
        })()
        return closePromise
    }
    const handleSignal = (signal: NodeJS.Signals) => {
        close()
            .catch((error: unknown) => {
                reportError(error instanceof Error ? error : new Error(String(error)))
            })
            .finally(() => {
                process.kill(process.pid, signal)
            })
    }
    process.once("SIGINT", handleSignal)
    process.once("SIGTERM", handleSignal)
    server.close = close
    return server
}

function scheduleGc(
    clankhouse: ClankHouse,
    options: GcOptions,
    reportError: (error: Error) => void
): () => Promise<void> {
    let running: Promise<void> | undefined
    const run = () => {
        if (running !== undefined) return
        running = clankhouse
            .gc(options)
            .then(
                () => {},
                (error: unknown) => reportError(error instanceof Error ? error : new Error(String(error)))
            )
            .catch(() => {})
            .finally(() => {
                running = undefined
            })
    }
    run()
    const timer = setInterval(run, GC_INTERVAL_MS).unref()
    return async () => {
        clearInterval(timer)
        await running
    }
}

/**
 * Binds a ClankHouse server and returns a handle with no auto-cleanup or signal handling.
 *
 * @see serve
 */
export async function listen(
    clankhouse: ClankHouse = defaultClankHouse(),
    options: ServeOptions = {}
): Promise<ClankHouseServer> {
    const { host = "127.0.0.1", port = 7331, tls, onError = reportServerError } = options

    validateAddress(host, port, tls)

    const credentials = await resolveCredentials(clankhouse.clankhouseDir)
    const shutdown = new AbortController()
    const handler = connectNodeAdapter({
        shutdownSignal: shutdown.signal,
        interceptors: [bearerAuth(credentials.apiKey)],
        routes(router) {
            router.service(ClankHouseService, clankhouseService(clankhouse))
        }
    })

    const server = tls === undefined ? http.createServer(handler) : https.createServer(tls, handler)
    await bindServer(server, port, host, onError)

    return createServerHandle(server, shutdown, host, tls === undefined ? "http" : "https", credentials)
}

function createServerHandle(
    server: http.Server | https.Server,
    shutdown: AbortController,
    host: string,
    protocol: "http" | "https",
    credentials: { apiKey: string; file: string }
): ClankHouseServer {
    const address = server.address()
    if (address === null || typeof address === "string") {
        server.close()
        throw new Error("ClankHouse server did not bind to a TCP address")
    }

    let closePromise: Promise<void> | undefined
    const result = {
        host,
        port: address.port,
        url: `${protocol}://${urlHost(host)}:${address.port}`,
        credentialsFile: credentials.file,
        close() {
            closePromise ??= closeHttpServer(server, shutdown)
            return closePromise
        }
    }
    Object.defineProperty(result, "apiKey", {
        configurable: false,
        enumerable: false,
        get: () => credentials.apiKey
    })

    return result as ClankHouseServer
}

function validateAddress(host: string, port: number, tls: https.ServerOptions | undefined): void {
    if (host.length === 0) throw new TypeError("host must not be empty")
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
        throw new TypeError("port must be an integer from 0 to 65535")
    if (!isLoopback(host) && tls === undefined) {
        throw new TypeError("TLS is required when binding ClankHouse to a non-loopback host")
    }
    if (tls !== undefined && !(hasKeyAndCertificate(tls) || tls.pfx !== undefined)) {
        throw new TypeError("TLS requires key and cert, or pfx")
    }
}

function isLoopback(host: string): boolean {
    if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true
    const octets = host.split(".")
    return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet))
}

function hasKeyAndCertificate(options: https.ServerOptions): boolean {
    return options.key !== undefined && options.cert !== undefined
}

function urlHost(host: string): string {
    return host.includes(":") ? `[${host}]` : host
}

function reportServerError(error: Error): void {
    console.error("ClankHouse server error", error)
}

function closeHttpServer(server: http.Server | https.Server, shutdown: AbortController): Promise<void> {
    shutdown.abort(new ConnectError("Server shutting down", Code.Unavailable))
    const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
        })
    })
    server.closeIdleConnections()
    const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS).unref()
    const force = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS).unref()
    return closed.finally(() => {
        clearInterval(sweep)
        clearTimeout(force)
    })
}
