import type { ServiceImpl } from "@connectrpc/connect"
import type { Loopy } from "@loopy/core/loopy"
import { LoopyService } from "./gen/loopy/server/v1/server_pb"
import { artifactHandlers } from "./rpc/artifacts"
import { eventHandlers } from "./rpc/events"
import { runHandlers } from "./rpc/runs"
import { sessionHandlers } from "./rpc/sessions"
import { workflowHandlers } from "./rpc/workflows"

export function loopyService(loopy: Loopy): ServiceImpl<typeof LoopyService> {
    return {
        ...workflowHandlers(loopy),
        ...runHandlers(loopy),
        ...eventHandlers(loopy),
        ...artifactHandlers(loopy),
        ...sessionHandlers(loopy)
    }
}
