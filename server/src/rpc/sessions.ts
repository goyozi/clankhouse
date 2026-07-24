import { Code, ConnectError } from "@connectrpc/connect"
import type { Loopy } from "@loopy/core/loopy"
import { toSession, toSessionMessage } from "../mappers"
import { notFound, required, throwIfAborted, toConnectError } from "./errors"
import type { LoopyServiceImplementation } from "./types"

type SessionHandlers = Pick<LoopyServiceImplementation, "getSession" | "watchSession">

export function sessionHandlers(loopy: Loopy): SessionHandlers {
    return {
        async getSession(request) {
            required(request.sessionId, "session_id")
            try {
                return { session: toSession(await loopy.sessions.get(request.sessionId)) }
            } catch (error) {
                throw toConnectError(error, {
                    ai_session_not_found: () => notFound("AI session", request.sessionId)
                })
            }
        },
        async *watchSession(request, context) {
            required(request.sessionId, "session_id")
            try {
                for await (const message of loopy.sessions.stream(request.sessionId, {
                    ...(request.afterMessageId !== undefined ? { afterMessageId: request.afterMessageId } : {}),
                    signal: context.signal
                })) {
                    yield { message: toSessionMessage(message) }
                }
                throwIfAborted(context.signal)
            } catch (error) {
                throw toConnectError(error, {
                    ai_session_not_found: () => notFound("AI session", request.sessionId),
                    ai_session_message_not_found: () =>
                        new ConnectError(
                            "after_message_id does not identify a message in the session",
                            Code.InvalidArgument
                        )
                })
            }
        }
    }
}
