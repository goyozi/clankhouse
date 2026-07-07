import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";
import { Loopy } from "../core/loopy";
import { tempDir } from "./helpers";

test("uses explicitly provided directory and creates the database", () => {
    // given a nested directory path that does not yet exist
    const dir = path.join(tempDir("loopy-dir-"), "nested", "loopy");

    // when a Loopy instance is created with that directory
    const loopy = new Loopy(dir);

    // then it uses the given directory as loopyDir
    expect(loopy.loopyDir).toBe(dir);
    // and it creates the database file inside it
    expect(fs.existsSync(path.join(dir, "loopy.db"))).toBe(true);
    loopy.close();
});

test("falls back to $LOOPY_DIR", () => {
    // given the LOOPY_DIR env var pointing at a temp directory
    const dir = path.join(tempDir("loopy-dir-"), "from-env");
    const previous = process.env.LOOPY_DIR;
    process.env.LOOPY_DIR = dir;
    try {
        // when a Loopy instance is created without an explicit directory
        const loopy = new Loopy();

        // then it uses the directory from LOOPY_DIR
        expect(loopy.loopyDir).toBe(dir);
        // and it creates the database file inside it
        expect(fs.existsSync(path.join(dir, "loopy.db"))).toBe(true);
        loopy.close();
    } finally {
        if (previous === undefined) delete process.env.LOOPY_DIR;
        else process.env.LOOPY_DIR = previous;
    }
});

test("defaults to ~/.loopy", () => {
    // given no LOOPY_DIR and a temp HOME directory
    const home = tempDir("loopy-home-");
    const previousHome = process.env.HOME;
    const previousLoopyDir = process.env.LOOPY_DIR;
    delete process.env.LOOPY_DIR;
    process.env.HOME = home;
    try {
        // when a Loopy instance is created without an explicit directory
        const loopy = new Loopy();

        // then it defaults loopyDir to .loopy under HOME
        expect(loopy.loopyDir).toBe(path.join(home, ".loopy"));
        // and it creates the database file inside it
        expect(fs.existsSync(path.join(home, ".loopy", "loopy.db"))).toBe(true);
        loopy.close();
    } finally {
        process.env.HOME = previousHome;
        if (previousLoopyDir !== undefined) process.env.LOOPY_DIR = previousLoopyDir;
    }
});

test("close releases the database", () => {
    // given an open Loopy instance
    const dir = tempDir("loopy-close-");
    const loopy = new Loopy(dir);

    // when it is closed
    loopy.close();

    // then further queries on its db throw
    expect(() => loopy.db.prepare("SELECT 1")).toThrow();

    // and when the same directory is reopened as a new Loopy instance
    const reopened = new Loopy(dir);

    // and then the runs table is empty and queryable
    expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    reopened.close();
});
