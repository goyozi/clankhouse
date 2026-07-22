import { expect, test } from "vitest"
import { LoopyError } from "@loopy/core/errors"

test("LoopyError exposes its stable code and standard Error fields", () => {
    // given an underlying failure
    const cause = new Error("underlying")

    // when a coded Loopy error is created
    const error = new LoopyError("workflow_run_not_found", "Workflow run not found: r1", { cause })

    // then it retains the Error contract and coded details
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(LoopyError)
    expect(error.name).toBe("LoopyError")
    expect(error.message).toBe("Workflow run not found: r1")
    expect(error.code).toBe("workflow_run_not_found")
    expect(error.cause).toBe(cause)
})
