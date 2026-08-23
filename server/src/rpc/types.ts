import type { ServiceImpl } from "@connectrpc/connect"
import { ClankHouseService } from "../gen/clankhouse/server/v1/server_pb"

export type ClankHouseServiceImplementation = ServiceImpl<typeof ClankHouseService>
