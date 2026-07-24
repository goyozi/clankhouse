import { Code, ConnectError } from "@connectrpc/connect"

export class CliError extends Error {
    readonly code: string

    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = "CliError"
        this.code = code
    }
}

export function publicError(error: unknown): { code: string; message: string } {
    if (error instanceof CliError) return { code: error.code, message: error.message }
    if (error instanceof ConnectError) return { code: connectCode(error.code), message: error.rawMessage }
    if (error instanceof Error) return { code: "internal", message: error.message }
    return { code: "internal", message: String(error) }
}

function connectCode(code: Code): string {
    switch (code) {
        case Code.Canceled:
            return "canceled"
        case Code.Unknown:
            return "unknown"
        case Code.InvalidArgument:
            return "invalid_argument"
        case Code.DeadlineExceeded:
            return "deadline_exceeded"
        case Code.NotFound:
            return "not_found"
        case Code.AlreadyExists:
            return "already_exists"
        case Code.PermissionDenied:
            return "permission_denied"
        case Code.ResourceExhausted:
            return "resource_exhausted"
        case Code.FailedPrecondition:
            return "failed_precondition"
        case Code.Aborted:
            return "aborted"
        case Code.OutOfRange:
            return "out_of_range"
        case Code.Unimplemented:
            return "unimplemented"
        case Code.Internal:
            return "internal"
        case Code.Unavailable:
            return "unavailable"
        case Code.DataLoss:
            return "data_loss"
        case Code.Unauthenticated:
            return "unauthenticated"
    }
}
