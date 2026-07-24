import { expect, test } from "vitest"
import { Loopy } from "@loopy/core/loopy"
import { tempDir } from "@loopy/test-utils"

test("closing marks the instance closed and releases its database", async () => {
    // given an open Loopy instance
    const loopy = new Loopy(tempDir("loopy-close-"))
    expect(loopy.closed).toBe(false)
    expect(await loopy.runs.list()).toEqual([])

    // when it is closed twice
    loopy.close()
    loopy.close()

    // then it reports closed and its database is released
    expect(loopy.closed).toBe(true)
    expect(loopy.db.open).toBe(false)
    // and it can no longer serve requests
    await expect(loopy.runs.list()).rejects.toThrow()
})
