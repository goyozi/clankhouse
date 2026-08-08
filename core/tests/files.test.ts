import * as fs from "node:fs"
import * as path from "node:path"
import { expect, test } from "vitest"
import { fileCreated, fileCreatedIn } from "@loopy/core/files"
import { gate, tempDir, tempLoopy, testRun } from "@loopy/test-utils"

test("fileCreated returns an existing regular file from its initial scan", async () => {
    // given a regular file that already exists
    const { loopy } = tempLoopy()
    const directory = tempDir("loopy-file-created-existing-")
    const target = path.join(directory, "feature.md")
    fs.writeFileSync(target, "plan")

    // when a workflow waits for that file using a relative path
    const result = await testRun(loopy, async () => loopy.waitFor(fileCreated(path.relative(process.cwd(), target))))

    // then the initial scan returns its absolute path and basename
    expect(result).toEqual({ path: target, filename: "feature.md" })
})

test("fileCreated detects a file renamed into its target path", async () => {
    // given a workflow watching an absent target file
    const { loopy } = tempLoopy()
    const directory = tempDir("loopy-file-created-rename-")
    const target = path.join(directory, "feature.md")
    const staged = path.join(directory, "staged.tmp")
    fs.writeFileSync(staged, "plan")
    const waiting = gate()
    const promise = testRun(loopy, async () => {
        waiting.release()
        return loopy.waitFor(fileCreated(target))
    })
    await waiting.released

    // when a regular file is renamed into the target path
    fs.renameSync(staged, target)

    // then the wait resolves with the target file
    expect(await promise).toEqual({ path: target, filename: "feature.md" })
})

test("fileCreated follows a symbolic link to a regular file", async () => {
    // given a symbolic-link target path that resolves to a regular file
    const { loopy } = tempLoopy()
    const directory = tempDir("loopy-file-created-symlink-")
    const file = path.join(directory, "feature.md")
    const linked = path.join(directory, "linked.md")
    fs.writeFileSync(file, "plan")
    fs.symlinkSync(file, linked)

    // when a workflow waits for the symbolic-link path
    const result = await testRun(loopy, async () => loopy.waitFor(fileCreated(linked)))

    // then the result retains the logical path to the link
    expect(result).toEqual({ path: linked, filename: "linked.md" })
})

test("fileCreatedIn deterministically selects a matching direct regular file", async () => {
    // given a directory containing multiple file kinds and matches
    const { loopy } = tempLoopy()
    const directory = tempDir("loopy-file-created-in-existing-")
    fs.mkdirSync(path.join(directory, "0-directory.md"))
    fs.mkdirSync(path.join(directory, "nested"))
    fs.writeFileSync(path.join(directory, "nested", "nested.md"), "nested")
    fs.writeFileSync(path.join(directory, "note.txt"), "note")
    fs.writeFileSync(path.join(directory, ".hidden.md"), "hidden")
    fs.writeFileSync(path.join(directory, "b.md"), "b")
    fs.writeFileSync(path.join(directory, "a.md"), "a")
    fs.symlinkSync(path.join(directory, "nested"), path.join(directory, "00-directory-link.md"))

    // when a workflow waits for a direct Markdown file
    const result = await testRun(loopy, async () => loopy.waitFor(fileCreatedIn(directory, { matching: "*.md" })))

    // then directories, nested files, links to directories, dotfiles, and non-matches are ignored
    expect(result).toEqual({ path: path.join(directory, "a.md"), filename: "a.md" })
})

test("fileCreatedIn follows a symbolic link to a regular file", async () => {
    // given a directory containing a matching file link and a dangling link
    const { loopy } = tempLoopy()
    const directory = tempDir("loopy-file-created-in-symlink-")
    const target = path.join(directory, "note.txt")
    const linked = path.join(directory, "result.md")
    fs.writeFileSync(target, "result")
    fs.symlinkSync(path.join(directory, "missing.txt"), path.join(directory, "00-dangling.md"))
    fs.symlinkSync(target, linked)

    // when a workflow waits for a matching file
    const result = await testRun(loopy, async () => loopy.waitFor(fileCreatedIn(directory, { matching: "*.md" })))

    // then the dangling link is ignored and the logical file-link path is returned
    expect(result).toEqual({ path: linked, filename: "result.md" })
})

test("fileCreatedIn detects a newly created matching direct file", async () => {
    // given a workflow watching a directory with no direct match
    const { loopy } = tempLoopy()
    const directory = tempDir("loopy-file-created-in-new-")
    fs.mkdirSync(path.join(directory, "nested"))
    fs.writeFileSync(path.join(directory, "nested", "ignored.md"), "nested")
    fs.writeFileSync(path.join(directory, "ignored.txt"), "text")
    const waiting = gate()
    const promise = testRun(loopy, async () => {
        waiting.release()
        return loopy.waitFor(fileCreatedIn(directory, { matching: "*.md" }))
    })
    await waiting.released

    // when a matching regular file is created directly in the watched directory
    const target = path.join(directory, "created.md")
    fs.writeFileSync(target, "created")

    // then the wait resolves with its absolute path and basename
    expect(await promise).toEqual({ path: target, filename: "created.md" })
})

test("file sources require watched paths to resolve to directories", async () => {
    // given an absent directory, a regular file, and a symbolic link to an existing directory
    const { loopy } = tempLoopy()
    const parent = tempDir("loopy-file-created-invalid-")
    const missing = path.join(parent, "missing")
    const file = path.join(parent, "file")
    const existing = path.join(parent, "existing")
    const linked = path.join(parent, "linked")
    fs.writeFileSync(file, "not a directory")
    fs.mkdirSync(existing)
    fs.writeFileSync(path.join(existing, "result.md"), "result")
    fs.symlinkSync(existing, linked)

    // when workflows start file sources against those directories
    const missingFile = testRun(loopy, async () => loopy.waitFor(fileCreated(path.join(missing, "file.md"))), {
        key: "missing-file"
    })
    const missingDirectory = testRun(loopy, async () => loopy.waitFor(fileCreatedIn(missing)), {
        key: "missing-directory"
    })
    const regularFile = testRun(loopy, async () => loopy.waitFor(fileCreatedIn(file)), {
        key: "regular-file"
    })
    const linkedDirectory = testRun(loopy, async () => loopy.waitFor(fileCreatedIn(linked)))

    // then absent directories retain the native filesystem error
    await expect(missingFile).rejects.toMatchObject({ code: "ENOENT" })
    await expect(missingDirectory).rejects.toMatchObject({ code: "ENOENT" })
    // and a path resolving to a non-directory is rejected explicitly
    await expect(regularFile).rejects.toThrow(/requires a directory/)
    // and a symbolic-link directory is followed while retaining its logical path
    await expect(linkedDirectory).resolves.toEqual({ path: path.join(linked, "result.md"), filename: "result.md" })
})
