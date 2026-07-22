import * as http from "node:http"
import * as https from "node:https"
import { Code, ConnectError } from "@connectrpc/connect"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { loopy as defaultLoopy } from "@loopy/core"
import type { Loopy } from "@loopy/core/loopy"
import { bearerAuth } from "./auth"
import { resolveCredentials } from "./credentials"
import { LoopyService } from "./gen/loopy/server/v1/server_pb"
import { listen } from "./listen"
import { loopyService } from "./service"

export type ServeOptions = {
    host?: string
    port?: number
    tls?: https.ServerOptions
    onError?: (error: Error) => void
}

export type LoopyServer = {
    host: string
    port: number
    url: string
    readonly apiKey: string
    credentialsFile: string
    close(): Promise<void>
}

export async function serve(loopy: Loopy = defaultLoopy(), options: ServeOptions = {}): Promise<LoopyServer> {
    const { host = "127.0.0.1", port = 7331, tls, onError = reportServerError } = options

    validateAddress(host, port, tls)

    const credentials = await resolveCredentials(loopy.loopyDir)
    const shutdown = new AbortController()
    const handler = connectNodeAdapter({
        shutdownSignal: shutdown.signal,
        interceptors: [bearerAuth(credentials.apiKey)],
        routes(router) {
            router.service(LoopyService, loopyService(loopy))
        }
    })

    const server = tls === undefined ? http.createServer(handler) : https.createServer(tls, handler)
    await listen(server, port, host, onError)

    return createServerHandle(server, shutdown, host, tls === undefined ? "http" : "https", credentials)
}

function createServerHandle(
    server: http.Server | https.Server,
    shutdown: AbortController,
    host: string,
    protocol: "http" | "https",
    credentials: { apiKey: string; file: string }
): LoopyServer {
    const address = server.address()
    if (address === null || typeof address === "string") {
        server.close()
        throw new Error("Loopy server did not bind to a TCP address")
    }

    let closePromise: Promise<void> | undefined
    const result = {
        host,
        port: address.port,
        url: `${protocol}://${urlHost(host)}:${address.port}`,
        credentialsFile: credentials.file,
        close() {
            closePromise ??= closeServer(server, shutdown)
            return closePromise
        }
    }
    Object.defineProperty(result, "apiKey", {
        configurable: false,
        enumerable: false,
        get: () => credentials.apiKey
    })

    return result as LoopyServer
}

function validateAddress(host: string, port: number, tls: https.ServerOptions | undefined): void {
    if (host.length === 0) throw new TypeError("host must not be empty")
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
        throw new TypeError("port must be an integer from 0 to 65535")
    if (!isLoopback(host) && tls === undefined) {
        throw new TypeError("TLS is required when binding Loopy to a non-loopback host")
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
    console.error("Loopy server error", error)
}

function closeServer(server: http.Server | https.Server, shutdown: AbortController): Promise<void> {
    shutdown.abort(new ConnectError("Server shutting down", Code.Unavailable))
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
        })
    })
}

export { LoopyService } from "./gen/loopy/server/v1/server_pb"
