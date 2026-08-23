import { Code, ConnectError } from "@connectrpc/connect"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { toSession, toSessionMessage } from "../mappers"
import { notFound, required, throwIfAborted, toConnectError } from "./errors"
import type { ClankHouseServiceImplementation } from "./types"

type SessionHandlers = Pick<ClankHouseServiceImplementation, "getSession" | "watchSession">

export function sessionHandlers(clankhouse: ClankHouse): SessionHandlers {
    return {
        async getSession(request) {
            required(request.sessionId, "session_id")
            try {
                return { session: toSession(await clankhouse.sessions.get(request.sessionId)) }
            } catch (error) {
                throw toConnectError(error, {
                    ai_session_not_found: () => notFound("AI session", request.sessionId)
                })
            }
        },
        async *watchSession(request, context) {
            required(request.sessionId, "session_id")
            try {
                for await (const message of clankhouse.sessions.stream(request.sessionId, {
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
