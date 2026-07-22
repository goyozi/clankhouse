import { Code, ConnectError } from "@connectrpc/connect"
import type { Loopy } from "@loopy/core/loopy"
import { parseJson, required, toConnectError } from "./errors"
import type { LoopyServiceImplementation } from "./types"

type EventHandlers = Pick<LoopyServiceImplementation, "emitEvent">

export function eventHandlers(loopy: Loopy): EventHandlers {
    return {
        async emitEvent(request) {
            required(request.key, "key")
            const payload = parseJson(request.inputJson, "input_json")
            if (payload === undefined) throw new ConnectError("input_json is required", Code.InvalidArgument)
            try {
                await loopy.emit(request.key, payload)
                return {}
            } catch (error) {
                throw toConnectError(error)
            }
        }
    }
}
