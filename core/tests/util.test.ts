import { expect, test } from "vitest"
import { newId, uniqueName } from "@clankhouse/core/util"

test("newId generates unique alphanumeric ids safe to pass as CLI arguments", () => {
    // given a large batch of generated ids
    const ids = Array.from({ length: 10_000 }, () => newId())

    // then every id consists of alphanumeric characters only
    const unexpected = ids.filter((id) => !/^[0-9A-Za-z]{21}$/.test(id))
    expect(unexpected).toEqual([])

    // and the ids are unique
    expect(new Set(ids).size).toBe(ids.length)
})

test("uniqueName keeps long values short enough for Windows paths while staying unique", () => {
    // given two long values that differ only at the start
    const first =
        "factory/C:\\Users\\runneradmin\\AppData\\Local\\Temp\\a\\factory\\implementation\\MY-123-fix-login.md"
    const second = first.replace("\\a\\", "\\b\\")

    // when unique names are derived from them
    const names = [uniqueName(first), uniqueName(second)]

    // then each name keeps the readable end of the value and stays bounded
    for (const name of names) {
        expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(name.length).toBe(49)
        expect(name).toContain("implementation-MY-123-fix-login-md-")
    }
    // and the names remain distinct
    expect(names[0]).not.toBe(names[1])
})
