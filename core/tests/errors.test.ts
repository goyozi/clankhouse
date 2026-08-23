import { expect, test } from "vitest"
import { ClankHouseError } from "@clankhouse/core/errors"

test("ClankHouseError exposes its stable code and standard Error fields", () => {
    // given an underlying failure
    const cause = new Error("underlying")

    // when a coded ClankHouse error is created
    const error = new ClankHouseError("workflow_run_not_found", "Workflow run not found: r1", { cause })

    // then it retains the Error contract and coded details
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ClankHouseError)
    expect(error.name).toBe("ClankHouseError")
    expect(error.message).toBe("Workflow run not found: r1")
    expect(error.code).toBe("workflow_run_not_found")
    expect(error.cause).toBe(cause)
})
