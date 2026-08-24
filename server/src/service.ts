import type { ServiceImpl } from "@connectrpc/connect"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { ClankHouseService } from "@clankhouse/protocol"
import { artifactHandlers } from "./rpc/artifacts.js"
import { eventHandlers } from "./rpc/events.js"
import { runHandlers } from "./rpc/runs.js"
import { sessionHandlers } from "./rpc/sessions.js"
import { workflowHandlers } from "./rpc/workflows.js"

export function clankhouseService(clankhouse: ClankHouse): ServiceImpl<typeof ClankHouseService> {
    return {
        ...workflowHandlers(clankhouse),
        ...runHandlers(clankhouse),
        ...eventHandlers(clankhouse),
        ...artifactHandlers(clankhouse),
        ...sessionHandlers(clankhouse)
    }
}
