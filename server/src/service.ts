import type { ServiceImpl } from "@connectrpc/connect"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import { ClankHouseService } from "./gen/clankhouse/server/v1/server_pb"
import { artifactHandlers } from "./rpc/artifacts"
import { eventHandlers } from "./rpc/events"
import { runHandlers } from "./rpc/runs"
import { sessionHandlers } from "./rpc/sessions"
import { workflowHandlers } from "./rpc/workflows"

export function clankhouseService(clankhouse: ClankHouse): ServiceImpl<typeof ClankHouseService> {
    return {
        ...workflowHandlers(clankhouse),
        ...runHandlers(clankhouse),
        ...eventHandlers(clankhouse),
        ...artifactHandlers(clankhouse),
        ...sessionHandlers(clankhouse)
    }
}
