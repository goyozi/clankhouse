import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";
import { tempDir } from "./helpers";

test("importing the package does not create the loopy dir until first use", async () => {
    // given a loopy dir path pointed to by the LOOPY_DIR env var
    const dir = path.join(tempDir("loopy-lazy-"), "loopy");
    const previous = process.env.LOOPY_DIR;
    process.env.LOOPY_DIR = dir;
    try {
        // when importing the package
        const mod = await import("../core/index");
        // then the loopy dir is not created just from importing
        expect(fs.existsSync(dir)).toBe(false);

        // when getting the loopy instance for the first time
        const instance = mod.loopy();
        // then the loopy db file is created
        expect(fs.existsSync(path.join(dir, "loopy.db"))).toBe(true);
        // and calling loopy() again returns the same cached instance
        expect(mod.loopy()).toBe(instance);
        instance.close();
    } finally {
        if (previous === undefined) delete process.env.LOOPY_DIR;
        else process.env.LOOPY_DIR = previous;
    }
});
