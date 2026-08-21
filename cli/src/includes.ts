import { InvalidArgumentError, type Command } from "commander"

export type IncludeOptions<Resource extends string> = {
    include: Resource[]
}

export function collectIncludes<Resource extends string>(
    allowed: readonly Resource[]
): (value: string, previous: Resource[]) => Resource[] {
    return (value, previous) => {
        if (!allowed.includes(value as Resource)) {
            throw new InvalidArgumentError(`allowed values are ${formatAllowedValues(allowed)}`)
        }
        return [...previous, value as Resource]
    }
}

export function includes<Resource extends string>(
    options: IncludeOptions<Resource>,
    command: Command,
    resource: Resource
): boolean {
    const verbose = command.optsWithGlobals<{ verbose?: boolean }>().verbose === true
    return verbose || options.include.includes("all" as Resource) || options.include.includes(resource)
}

function formatAllowedValues(values: readonly string[]): string {
    if (values.length === 1) return values[0]!
    if (values.length === 2) return `${values[0]} and ${values[1]}`
    return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`
}
