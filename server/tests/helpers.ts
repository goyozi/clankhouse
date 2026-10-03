import * as net from "node:net"
import type { RequestOptions } from "node:https"
import { createClient, type Interceptor } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-node"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { ClankHouseService, ExecutionStatus } from "@clankhouse/protocol"
import { onTestFinished } from "vitest"
import { listen, type ClankHouseServer } from "../src"

export function bearer(apiKey: string): Interceptor {
    return (next) => async (request) => {
        request.header.set("authorization", `Bearer ${apiKey}`)
        return next(request)
    }
}

export function rpcClient(server: ClankHouseServer, apiKey = server.apiKey, nodeOptions?: RequestOptions) {
    return createClient(
        ClankHouseService,
        createConnectTransport({
            httpVersion: "1.1",
            baseUrl: server.url,
            interceptors: apiKey.length === 0 ? [] : [bearer(apiKey)],
            ...(nodeOptions !== undefined ? { nodeOptions } : {})
        })
    )
}

export async function testServer(clankhouse: ClankHouse): Promise<ClankHouseServer> {
    const server = await listen(clankhouse, { port: 0 })
    onTestFinished(() => server.close())
    return server
}

export async function freePort(port = 0): Promise<number> {
    const probe = net.createServer()
    await new Promise<void>((resolve, reject) => {
        probe.once("error", reject)
        probe.listen(port, "127.0.0.1", resolve)
    })
    const bound = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return bound
}

export async function nextRunningStep(
    iterator: AsyncIterator<{ item: { case: "step" | "run" | undefined; value?: unknown } }>,
    key: string
): Promise<void> {
    while (true) {
        const item = await iterator.next()
        if (item.done) throw new Error(`Run stream ended before ${key} started`)
        if (
            item.value.item.case === "step" &&
            typeof item.value.item.value === "object" &&
            item.value.item.value !== null &&
            "key" in item.value.item.value &&
            item.value.item.value.key === key &&
            "status" in item.value.item.value &&
            item.value.item.value.status === ExecutionStatus.RUNNING
        ) {
            return
        }
    }
}
