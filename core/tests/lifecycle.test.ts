import { expect, test } from "vitest"
import { ClankHouse } from "@clankhouse/core/clankhouse"
import { tempDir } from "@clankhouse/test-utils"

test("closing marks the instance closed and releases its database", async () => {
    // given an open ClankHouse instance
    const clankhouse = new ClankHouse(tempDir("clankhouse-close-"))
    expect(clankhouse.closed).toBe(false)
    expect(await clankhouse.runs.list()).toEqual([])

    // when it is closed twice
    clankhouse.close()
    clankhouse.close()

    // then it reports closed and its database is released
    expect(clankhouse.closed).toBe(true)
    expect(clankhouse.db.open).toBe(false)
    // and it can no longer serve requests
    await expect(clankhouse.runs.list()).rejects.toThrow()
})
