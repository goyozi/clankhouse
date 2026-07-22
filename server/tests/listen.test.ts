import * as http from "node:http"
import { expect, onTestFinished, test } from "vitest"
import { listen } from "../src/listen"

test("rejects bind errors without reporting them as runtime errors", async () => {
    // given a server already bound to a loopback port
    const bound = http.createServer()
    await listen(bound, 0, "127.0.0.1", () => {})
    onTestFinished(() => close(bound))
    const address = bound.address()
    if (address === null || typeof address === "string") throw new Error("Expected a TCP address")
    const candidate = http.createServer()
    onTestFinished(() => close(candidate))
    const runtimeErrors: Error[] = []

    // when another server tries to bind to the same port
    const result = listen(candidate, address.port, "127.0.0.1", (error) => runtimeErrors.push(error))

    // then startup rejects and the runtime callback is not invoked
    await expect(result).rejects.toMatchObject({ code: "EADDRINUSE" })
    expect(runtimeErrors).toEqual([])
})

test("reports errors emitted after binding and remains listening", async () => {
    // given a bound server with a runtime error callback
    const server = http.createServer()
    const errors: Error[] = []
    await listen(server, 0, "127.0.0.1", (error) => errors.push(error))
    onTestFinished(() => close(server))
    const first = new Error("first")
    const second = new Error("second")

    // when errors are emitted after binding
    server.emit("error", first)
    server.emit("error", second)

    // then every error is reported without stopping the server
    expect(errors).toEqual([first, second])
    expect(server.listening).toBe(true)
})

function close(server: http.Server): Promise<void> {
    if (!server.listening) return Promise.resolve()
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
        })
    })
}
