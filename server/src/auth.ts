import { createHash, timingSafeEqual } from "node:crypto"
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect"

export function bearerAuth(apiKey: string): Interceptor {
    const expected = digest(`Bearer ${apiKey}`)
    return (next) => async (request) => {
        const authorization = request.header.get("authorization")
        if (authorization === null || !timingSafeEqual(expected, digest(authorization))) {
            throw new ConnectError("Authentication required", Code.Unauthenticated)
        }
        return next(request)
    }
}

function digest(value: string): Buffer {
    return createHash("sha256").update(value).digest()
}
