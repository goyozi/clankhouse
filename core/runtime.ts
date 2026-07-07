import type { PersistedStatus } from "./db";

export type ActiveSets = {
    runs: Map<string, { promise: Promise<unknown> }>,
    steps: Set<string>,
    sessions: Set<string>
}

export function observableStatus(persisted: PersistedStatus, isActive: boolean): PersistedStatus | "running" {
    return persisted === "interrupted" && isActive ? "running" : persisted;
}
