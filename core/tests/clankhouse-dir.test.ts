import * as fs from "node:fs"
import * as path from "node:path"
import { expect, test } from "vitest"
import { ClankHouse } from "@clankhouse/core/clankhouse"
import { tempDir } from "@clankhouse/test-utils"

test("uses explicitly provided directory and creates the database", () => {
    // given a nested directory path that does not yet exist
    const dir = path.join(tempDir("clankhouse-dir-"), "nested", "clankhouse")

    // when a ClankHouse instance is created with that directory
    const clankhouse = new ClankHouse(dir)

    // then it uses the given directory as clankhouseDir
    expect(clankhouse.clankhouseDir).toBe(dir)
    // and it creates the database file inside it
    expect(fs.existsSync(path.join(dir, "clankhouse.db"))).toBe(true)
    clankhouse.close()
})

test.skipIf(process.platform === "win32")("creates new clankhouse directories with owner-only permissions", () => {
    // given a nested clankhouse directory that does not exist
    const dir = path.join(tempDir("clankhouse-dir-"), "private")

    // when a ClankHouse instance creates it
    const clankhouse = new ClankHouse(dir)

    // then the directory is accessible only by its owner
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    clankhouse.close()
})

test.skipIf(process.platform === "win32")("does not change permissions on an existing clankhouse directory", () => {
    // given an existing clankhouse directory with broader permissions
    const dir = tempDir("clankhouse-existing-")
    fs.chmodSync(dir, 0o755)

    // when a ClankHouse instance uses it
    const clankhouse = new ClankHouse(dir)

    // then the existing directory permissions remain unchanged
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755)
    clankhouse.close()
})

test("falls back to $CLANKHOUSE_DIR", () => {
    // given the CLANKHOUSE_DIR env var pointing at a temp directory
    const dir = path.join(tempDir("clankhouse-dir-"), "from-env")
    const previous = process.env.CLANKHOUSE_DIR
    process.env.CLANKHOUSE_DIR = dir
    try {
        // when a ClankHouse instance is created without an explicit directory
        const clankhouse = new ClankHouse()

        // then it uses the directory from CLANKHOUSE_DIR
        expect(clankhouse.clankhouseDir).toBe(dir)
        // and it creates the database file inside it
        expect(fs.existsSync(path.join(dir, "clankhouse.db"))).toBe(true)
        clankhouse.close()
    } finally {
        if (previous === undefined) delete process.env.CLANKHOUSE_DIR
        else process.env.CLANKHOUSE_DIR = previous
    }
})

test("defaults to ~/.clankhouse", () => {
    // given no CLANKHOUSE_DIR and a temporary home directory
    const home = tempDir("clankhouse-home-")
    const homeVariable = process.platform === "win32" ? "USERPROFILE" : "HOME"
    const previousHome = process.env[homeVariable]
    const previousClankHouseDir = process.env.CLANKHOUSE_DIR
    delete process.env.CLANKHOUSE_DIR
    process.env[homeVariable] = home
    try {
        // when a ClankHouse instance is created without an explicit directory
        const clankhouse = new ClankHouse()

        // then it defaults clankhouseDir to .clankhouse under HOME
        expect(clankhouse.clankhouseDir).toBe(path.join(home, ".clankhouse"))
        // and it creates the database file inside it
        expect(fs.existsSync(path.join(home, ".clankhouse", "clankhouse.db"))).toBe(true)
        clankhouse.close()
    } finally {
        if (previousHome === undefined) delete process.env[homeVariable]
        else process.env[homeVariable] = previousHome
        if (previousClankHouseDir !== undefined) process.env.CLANKHOUSE_DIR = previousClankHouseDir
    }
})

test("close releases the database", () => {
    // given an open ClankHouse instance
    const dir = tempDir("clankhouse-close-")
    const clankhouse = new ClankHouse(dir)

    // when it is closed
    clankhouse.close()

    // then further queries on its db throw
    expect(() => clankhouse.db.prepare("SELECT 1")).toThrow()

    // and when the same directory is reopened as a new ClankHouse instance
    const reopened = new ClankHouse(dir)

    // and then the runs table is empty and queryable
    expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 })
    reopened.close()
})
