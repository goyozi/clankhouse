import type { ServiceImpl } from "@connectrpc/connect"
import { ClankHouseService } from "@clankhouse/protocol"

export type ClankHouseServiceImplementation = ServiceImpl<typeof ClankHouseService>
