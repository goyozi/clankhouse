import { Command } from "commander"
import { expect, test } from "vitest"
import { collectIncludes } from "../src/includes"

test("collects includes without mutating the command default", () => {
    // given a command with a repeatable include option
    const command = new Command().option(
        "--include <resource>",
        "include resources",
        collectIncludes(["sessions", "tool-io"] as const),
        []
    )

    // when the same command instance parses two separate invocations
    command.parse(["--include", "sessions"], { from: "user" })
    const first = command.opts<{ include: string[] }>().include
    command.parse(["--include", "tool-io"], { from: "user" })
    const second = command.opts<{ include: string[] }>().include

    // then each invocation starts from the unchanged default
    expect(first).toEqual(["sessions"])
    expect(second).toEqual(["tool-io"])
    expect(command.options[0]!.defaultValue).toEqual([])
})
