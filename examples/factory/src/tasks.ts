import { mkdirSync } from "node:fs"
import * as path from "node:path"
import { ClankHouseError, fileCreatedIn, type TriggerHandle, type WorkflowRef } from "@clankhouse/core"
import type { ClankHouse } from "@clankhouse/core/clankhouse"
import type { FactoryInput } from "./workflow"

const TASK_STATES = ["requirements", "implementation", "done"] as const

export function taskDirectory(repositoryPath: string, state: (typeof TASK_STATES)[number]): string {
    return path.join(repositoryPath, "factory", state)
}

export function watchTasks(
    instance: ClankHouse,
    repositoryPath: string,
    workflow: WorkflowRef<FactoryInput>
): TriggerHandle {
    const repository = path.resolve(repositoryPath)
    for (const state of TASK_STATES) mkdirSync(taskDirectory(repository, state), { recursive: true })
    return instance.addTrigger(
        fileCreatedIn(taskDirectory(repository, "implementation"), { matching: "*.md" }),
        workflow,
        {
            eventToInput: ({ path: task }) => ({ repositoryPath: repository, task }),
            onError: (error) => {
                if (error instanceof ClankHouseError && error.code === "workflow_run_failed") return
                console.error(`Factory trigger error in ${repository}`, error)
            }
        }
    )
}
