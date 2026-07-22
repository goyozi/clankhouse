import { Code, ConnectError } from "@connectrpc/connect"
import { LoopyError, type LoopyErrorCode } from "@loopy/core/errors"

type ErrorMapping = Code | ((error: LoopyError) => ConnectError)
type ErrorMappings = Partial<Record<LoopyErrorCode, ErrorMapping>>

export function required(value: string, field: string): void {
    if (value.length === 0) throw new ConnectError(`${field} is required`, Code.InvalidArgument)
}

export function parseJson(text: string | undefined, field: string): unknown {
    if (text === undefined) return undefined
    try {
        return JSON.parse(text)
    } catch (cause) {
        throw new ConnectError(`${field} must contain valid JSON`, Code.InvalidArgument, undefined, undefined, cause)
    }
}

export function notFound(kind: string, id: string): ConnectError {
    return new ConnectError(`${kind} not found: ${id}`, Code.NotFound)
}

export function toConnectError(error: unknown, mappings: ErrorMappings = {}): ConnectError {
    if (error instanceof ConnectError) return error
    if (error instanceof DOMException && error.name === "AbortError") {
        return new ConnectError("Request canceled", Code.Canceled)
    }
    if (error instanceof LoopyError) {
        const mapping = mappings[error.code]
        if (typeof mapping === "function") return mapping(error)
        if (mapping !== undefined) return new ConnectError(error.message, mapping)
    }
    return new ConnectError("Internal server error", Code.Internal, undefined, undefined, error)
}
