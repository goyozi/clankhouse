import { Code, ConnectError } from "@connectrpc/connect"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { parseJson, required, toConnectError } from "./errors.js"
import type { ClankHouseServiceImplementation } from "./types.js"

type EventHandlers = Pick<ClankHouseServiceImplementation, "emitEvent">

export function eventHandlers(clankhouse: ClankHouse): EventHandlers {
    return {
        async emitEvent(request) {
            required(request.key, "key")
            const payload = parseJson(request.inputJson, "input_json")
            if (payload === undefined) throw new ConnectError("input_json is required", Code.InvalidArgument)
            try {
                await clankhouse.emit(request.key, payload)
                return {}
            } catch (error) {
                throw toConnectError(error)
            }
        }
    }
}
