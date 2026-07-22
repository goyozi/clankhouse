import type { ServiceImpl } from "@connectrpc/connect"
import { LoopyService } from "../gen/loopy/server/v1/server_pb"

export type LoopyServiceImplementation = ServiceImpl<typeof LoopyService>
