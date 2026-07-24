import { expect, test } from "vitest"
import { newId } from "@loopy/core/util"

test("newId generates unique alphanumeric ids safe to pass as CLI arguments", () => {
    // given a large batch of generated ids
    const ids = Array.from({ length: 10_000 }, () => newId())

    // then every id consists of alphanumeric characters only
    const unexpected = ids.filter((id) => !/^[0-9A-Za-z]{21}$/.test(id))
    expect(unexpected).toEqual([])

    // and the ids are unique
    expect(new Set(ids).size).toBe(ids.length)
})
