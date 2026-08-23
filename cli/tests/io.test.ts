import * as fs from "node:fs"
import * as path from "node:path"
import { Readable } from "node:stream"
import { tempDir } from "@clankhouse/test-utils"
import { expect, test } from "vitest"
import { copyWithoutClobber, readJsonInput } from "../src/io"

test("reading JSON input from a file respects cancellation", async () => {
    // given a valid JSON input file and an already-cancelled operation
    const cwd = tempDir("clankhouse-input-")
    fs.writeFileSync(path.join(cwd, "input.json"), "{}")
    const controller = new AbortController()
    controller.abort()

    // when the file is read
    const reading = readJsonInput("input.json", cwd, Readable.from([]), controller.signal)

    // then the read is rejected with the input error caused by cancellation
    await expect(reading).rejects.toMatchObject({
        code: "input",
        cause: expect.objectContaining({ name: "AbortError" })
    })
})

test("copy without clobber does not start its source when the destination exists", async () => {
    // given an existing destination and an observable lazy byte source
    const destination = path.join(tempDir("clankhouse-copy-"), "existing.txt")
    fs.writeFileSync(destination, "existing")
    let starts = 0
    const source = () => {
        starts++
        return (async function* () {
            yield Buffer.from("replacement")
        })()
    }

    // when a no-clobber copy is attempted
    const copy = copyWithoutClobber(destination, source)

    // then the copy fails before starting the source and preserves the destination
    await expect(copy).rejects.toMatchObject({ code: "already_exists" })
    expect(starts).toBe(0)
    expect(fs.readFileSync(destination, "utf8")).toBe("existing")
})
