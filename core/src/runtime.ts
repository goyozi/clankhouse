export type ActiveSets = {
    runs: Map<string, { promise: Promise<unknown>; controller: AbortController }>
    steps: Set<string>
    sessions: Set<string>
}

export function observableStatus<S extends string>(persisted: S, isActive: boolean): S | "running" {
    return persisted === "interrupted" && isActive ? "running" : persisted
}
