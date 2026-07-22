import type * as http from "node:http"
import type * as https from "node:https"

export function listen(
    server: http.Server | https.Server,
    port: number,
    host: string,
    onRuntimeError: (error: Error) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        let listening = false
        const onError = (error: Error) => {
            if (listening) {
                onRuntimeError(error)
                return
            }
            server.off("error", onError)
            reject(error)
        }
        server.on("error", onError)
        server.listen(port, host, () => {
            listening = true
            resolve()
        })
    })
}
