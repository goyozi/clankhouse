import * as fs from "node:fs"
import * as path from "node:path"
import { expect, onTestFinished, test } from "vitest"
import { fileCreated, fileCreatedIn } from "@clankhouse/core/files"
import { gate, tempDir, tempClankHouse, testRun } from "@clankhouse/test-utils"

test("fileCreated returns an existing regular file from its initial scan", async () => {
    // given a regular file that already exists
    const { clankhouse } = tempClankHouse()
    const directory = tempDir("clankhouse-file-created-existing-")
    const target = path.join(directory, "feature.md")
    fs.writeFileSync(target, "plan")

    // when a workflow waits for that file using a relative path
    const result = await testRun(clankhouse, async () =>
        clankhouse.waitFor(fileCreated(path.relative(process.cwd(), target)))
    )

    // then the initial scan returns its absolute path and basename
    expect(result).toEqual({ path: target, filename: "feature.md" })
})

test.each(["all", "first"] as const)("fileCreated initial %s emits an existing target", async (initial) => {
    // given an existing regular file
    const { clankhouse } = tempClankHouse()
    const directory = tempDir(`clankhouse-file-created-${initial}-`)
    const target = path.join(directory, "feature.md")
    fs.writeFileSync(target, "plan")

    // when a workflow waits with an emitting initial policy
    const result = await testRun(clankhouse, async () => clankhouse.waitFor(fileCreated(target, { initial })))

    // then the initial scan returns the existing target
    expect(result).toEqual({ path: target, filename: "feature.md" })
})

test("fileCreated initial none suppresses an existing target but emits an observed re-creation", async () => {
    // given an existing target watched with initial events disabled
    const directory = tempDir("clankhouse-file-created-none-")
    const target = path.join(directory, "feature.md")
    fs.writeFileSync(target, "initial")
    const events: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const recreated = gate()
    const handle = fileCreated(target, { initial: "none" }).start({
        emit(event) {
            events.push(event)
            recreated.release()
        },
        fail(error) {
            failures.push(error)
            recreated.release()
        }
    })
    onTestFinished(() => handle.stop())

    // when the initial scan completes and a later scan observes the target absent before it is re-created
    await handle.check!()
    expect(events).toEqual([])
    fs.unlinkSync(target)
    await handle.check!()
    fs.writeFileSync(target, "recreated")
    await recreated.released

    // then only the observed re-creation is emitted
    expect(failures).toEqual([])
    expect(events).toEqual([{ path: target, filename: "feature.md" }])
})

test("file source keys identify their resolved initial policy", () => {
    // given target and directory sources using omitted and explicit initial policies
    const target = path.join("source-key", "feature.md")
    const directory = path.dirname(target)
    const targetDefault = fileCreated(target)
    const targetAll = fileCreated(target, { initial: "all" })
    const targetFirst = fileCreated(target, { initial: "first" })
    const targetNone = fileCreated(target, { initial: "none" })
    const directoryDefault = fileCreatedIn(directory, { matching: "*.md" })
    const directoryAll = fileCreatedIn(directory, { matching: "*.md", initial: "all" })
    const directoryFirst = fileCreatedIn(directory, { matching: "*.md", initial: "first" })
    const directoryNone = fileCreatedIn(directory, { matching: "*.md", initial: "none" })

    // when their keys are compared
    const targetKeys = new Set([targetAll.key, targetFirst.key, targetNone.key])
    const directoryKeys = new Set([directoryAll.key, directoryFirst.key, directoryNone.key])

    // then the default is all and each distinct policy has a distinct identity
    expect(targetDefault.key).toBe(targetAll.key)
    expect(directoryDefault.key).toBe(directoryAll.key)
    expect(targetKeys.size).toBe(3)
    expect(directoryKeys.size).toBe(3)
})

test("a check requested during an observation waits for a fresh snapshot", async () => {
    // given a directory source whose first emission creates another matching file
    const directory = tempDir("clankhouse-file-check-pending-")
    const first = path.join(directory, "a.md")
    const second = path.join(directory, "b.md")
    fs.writeFileSync(first, "first")
    const events: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const requested = gate()
    let pending: Promise<void> | undefined
    const handle = fileCreatedIn(directory, { matching: "*.md" }).start({
        emit(event) {
            events.push(event)
            if (event.path === first) {
                fs.writeFileSync(second, "second")
                pending = handle.check!()
                requested.release()
            }
        },
        fail(error) {
            failures.push(error)
            requested.release()
        }
    })
    onTestFinished(() => handle.stop())

    // when the check requested during the initial observation finishes
    await requested.released
    await pending

    // then the fresh snapshot has emitted the file created after the initial snapshot
    expect(failures).toEqual([])
    expect(events).toEqual([
        { path: first, filename: "a.md" },
        { path: second, filename: "b.md" }
    ])
})

test("file checks reject failed observations and allow recovery", async () => {
    // given a source that has established an empty baseline
    const directory = tempDir("clankhouse-file-check-failed-")
    const target = path.join(directory, "created.md")
    const events: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const handle = fileCreatedIn(directory).start({
        emit: (event) => events.push(event),
        fail: (error) => failures.push(error)
    })
    onTestFinished(() => handle.stop())
    await handle.check!()

    // when the observed directory disappears before a requested check
    fs.rmdirSync(directory)
    await expect(handle.check!()).rejects.toMatchObject({ code: "ENOENT" })

    // then the listener receives the failure without an event
    expect(failures).toContainEqual(expect.objectContaining({ code: "ENOENT" }))
    expect(events).toEqual([])

    // when the directory is restored with a matching file and checked again
    fs.mkdirSync(directory)
    fs.writeFileSync(target, "created")
    await handle.check!()

    // then the source resumes observation and emits the new file
    expect(events).toEqual([{ path: target, filename: "created.md" }])
})

test("file checks reject failed observations even when the failure listener throws", async () => {
    // given an empty directory source whose failure listener throws
    const directory = tempDir("clankhouse-file-check-failure-listener-")
    const target = path.join(directory, "created.md")
    const events: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const listenerError = new Error("failure listener failed")
    const handle = fileCreatedIn(directory).start({
        emit: (event) => events.push(event),
        fail(error) {
            failures.push(error)
            throw listenerError
        }
    })
    onTestFinished(() => handle.stop())
    await handle.check!()

    // when the directory disappears and concurrent checks fail
    fs.rmdirSync(directory)
    const results = await Promise.allSettled([handle.check!(), handle.check!()])

    // then every check rejects with the observation error despite the listener throwing
    expect(results).toEqual([
        { status: "rejected", reason: expect.objectContaining({ code: "ENOENT" }) },
        { status: "rejected", reason: expect.objectContaining({ code: "ENOENT" }) }
    ])
    expect(failures).toContainEqual(expect.objectContaining({ code: "ENOENT" }))

    // when the directory is restored and checked again
    fs.mkdirSync(directory)
    fs.writeFileSync(target, "created")
    await handle.check!()

    // then observation recovers without leaking the listener exception
    expect(events).toEqual([{ path: target, filename: "created.md" }])
})

test("stopping a file source settles queued checks and suppresses later emissions", async () => {
    // given a file source with an initial observation and explicit checks in progress
    const directory = tempDir("clankhouse-file-check-stopped-")
    fs.writeFileSync(path.join(directory, "existing.md"), "existing")
    const events: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const handle = fileCreatedIn(directory).start({
        emit: (event) => events.push(event),
        fail: (error) => failures.push(error)
    })
    onTestFinished(() => handle.stop())
    const checks = [handle.check!(), handle.check!()]

    // when the source is stopped before its observations complete
    handle.stop()
    await Promise.all(checks)
    await handle.check!()

    // then queued and subsequent checks settle without delivering events or failures
    expect(events).toEqual([])
    expect(failures).toEqual([])
})

test("fileCreated detects a file renamed into its target path", async () => {
    // given a workflow watching an absent target file
    const { clankhouse } = tempClankHouse()
    const directory = tempDir("clankhouse-file-created-rename-")
    const target = path.join(directory, "feature.md")
    const staged = path.join(directory, "staged.tmp")
    fs.writeFileSync(staged, "plan")
    const waiting = gate()
    const promise = testRun(clankhouse, async () => {
        waiting.release()
        return clankhouse.waitFor(fileCreated(target))
    })
    await waiting.released

    // when a regular file is renamed into the target path
    fs.renameSync(staged, target)

    // then the wait resolves with the target file
    expect(await promise).toEqual({ path: target, filename: "feature.md" })
})

test("fileCreated follows a symbolic link to a regular file", async () => {
    // given a symbolic-link target path that resolves to a regular file
    const { clankhouse } = tempClankHouse()
    const directory = tempDir("clankhouse-file-created-symlink-")
    const file = path.join(directory, "feature.md")
    const linked = path.join(directory, "linked.md")
    fs.writeFileSync(file, "plan")
    fs.symlinkSync(file, linked)

    // when a workflow waits for the symbolic-link path
    const result = await testRun(clankhouse, async () => clankhouse.waitFor(fileCreated(linked)))

    // then the result retains the logical path to the link
    expect(result).toEqual({ path: linked, filename: "linked.md" })
})

test("fileCreatedIn deterministically selects a matching direct regular file", async () => {
    // given a directory containing multiple file kinds and matches
    const { clankhouse } = tempClankHouse()
    const directory = tempDir("clankhouse-file-created-in-existing-")
    fs.mkdirSync(path.join(directory, "0-directory.md"))
    fs.mkdirSync(path.join(directory, "nested"))
    fs.writeFileSync(path.join(directory, "nested", "nested.md"), "nested")
    fs.writeFileSync(path.join(directory, "note.txt"), "note")
    fs.writeFileSync(path.join(directory, ".hidden.md"), "hidden")
    fs.writeFileSync(path.join(directory, "b.md"), "b")
    fs.writeFileSync(path.join(directory, "a.md"), "a")
    fs.symlinkSync(path.join(directory, "nested"), path.join(directory, "00-directory-link.md"))

    // when a workflow waits for a direct Markdown file
    const result = await testRun(clankhouse, async () =>
        clankhouse.waitFor(fileCreatedIn(directory, { matching: "*.md" }))
    )

    // then directories, nested files, links to directories, dotfiles, and non-matches are ignored
    expect(result).toEqual({ path: path.join(directory, "a.md"), filename: "a.md" })
})

test("fileCreatedIn default and explicit all emit every initial match in deterministic order", async () => {
    // given multiple existing matches observed by default and explicit all sources
    const directory = tempDir("clankhouse-file-created-in-all-")
    const first = path.join(directory, "a.md")
    const second = path.join(directory, "b.md")
    fs.writeFileSync(second, "second")
    fs.writeFileSync(first, "first")
    fs.writeFileSync(path.join(directory, "ignored.txt"), "ignored")
    const defaultEvents: Array<{ path: string; filename: string }> = []
    const explicitEvents: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const defaultComplete = gate()
    const explicitComplete = gate()
    const fail = (error: unknown) => {
        failures.push(error)
        defaultComplete.release()
        explicitComplete.release()
    }
    const defaultHandle = fileCreatedIn(directory, { matching: "*.md" }).start({
        emit(event) {
            defaultEvents.push(event)
            if (defaultEvents.length === 2) defaultComplete.release()
        },
        fail
    })
    const explicitHandle = fileCreatedIn(directory, { matching: "*.md", initial: "all" }).start({
        emit(event) {
            explicitEvents.push(event)
            if (explicitEvents.length === 2) explicitComplete.release()
        },
        fail
    })
    onTestFinished(() => {
        defaultHandle.stop()
        explicitHandle.stop()
    })

    // when both initial scans complete
    await Promise.all([defaultComplete.released, explicitComplete.released])

    // then both sources emit all matches alphabetically and ignore non-matches
    expect(failures).toEqual([])
    const expected = [
        { path: first, filename: "a.md" },
        { path: second, filename: "b.md" }
    ]
    expect(defaultEvents).toEqual(expected)
    expect(explicitEvents).toEqual(expected)
})

test.each(["all", "first"] as const)(
    "fileCreatedIn initial %s retries failed emissions without repeating successful deliveries",
    async (initial) => {
        // given existing matches and a listener that fails once while delivering the initial snapshot
        const directory = tempDir("clankhouse-file-created-in-retry-")
        const first = path.join(directory, "a.md")
        const second = path.join(directory, "b.md")
        const third = path.join(directory, "c.md")
        for (const target of [first, second, third]) fs.writeFileSync(target, "existing")
        const events: Array<{ path: string; filename: string }> = []
        const failures: unknown[] = []
        const failed = gate()
        const deliveryError = new Error("delivery failed")
        const failedPath = initial === "all" ? second : first
        let shouldFail = true
        const handle = fileCreatedIn(directory, { initial }).start({
            emit(event) {
                if (event.path === failedPath && shouldFail) {
                    shouldFail = false
                    throw deliveryError
                }
                events.push(event)
            },
            fail(error) {
                failures.push(error)
                failed.release()
            }
        })
        onTestFinished(() => handle.stop())

        // when the initial delivery fails and subsequent checks retry observation
        await failed.released
        await handle.check!()
        await handle.check!()

        // then eligible files are delivered once and initially suppressed files stay suppressed
        expect(failures).toEqual([deliveryError])
        const expected = [{ path: first, filename: "a.md" }]
        if (initial === "all") {
            expected.push({ path: second, filename: "b.md" }, { path: third, filename: "c.md" })
        }
        expect(events).toEqual(expected)
    }
)

test("fileCreatedIn initial first emits one initial match and observes the rest", async () => {
    // given multiple existing matches watched with initial first
    const directory = tempDir("clankhouse-file-created-in-first-")
    const first = path.join(directory, "a.md")
    const skipped = path.join(directory, "b.md")
    const created = path.join(directory, "c.md")
    fs.writeFileSync(skipped, "skipped")
    fs.writeFileSync(first, "first")
    const events: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const initialObserved = gate()
    const createdObserved = gate()
    const handle = fileCreatedIn(directory, { matching: "*.md", initial: "first" }).start({
        emit(event) {
            events.push(event)
            if (events.length === 1) initialObserved.release()
            if (event.path === created) createdObserved.release()
        },
        fail(error) {
            failures.push(error)
            initialObserved.release()
            createdObserved.release()
        }
    })
    onTestFinished(() => handle.stop())
    await initialObserved.released

    // when a new matching file is created after the initial snapshot
    fs.writeFileSync(created, "created")
    await createdObserved.released

    // then only the first initial match and the later creation are emitted
    expect(failures).toEqual([])
    expect(events).toEqual([
        { path: first, filename: "a.md" },
        { path: created, filename: "c.md" }
    ])
})

test("fileCreatedIn initial none observes existing matches without emitting them", async () => {
    // given multiple existing matches watched with initial events disabled
    const directory = tempDir("clankhouse-file-created-in-none-")
    fs.writeFileSync(path.join(directory, "a.md"), "first")
    fs.writeFileSync(path.join(directory, "b.md"), "second")
    const created = path.join(directory, "c.md")
    const events: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const createdObserved = gate()
    const handle = fileCreatedIn(directory, { matching: "*.md", initial: "none" }).start({
        emit(event) {
            events.push(event)
            createdObserved.release()
        },
        fail(error) {
            failures.push(error)
            createdObserved.release()
        }
    })
    onTestFinished(() => handle.stop())

    // when the initial snapshot completes and a new matching file is created
    await handle.check!()
    expect(events).toEqual([])
    fs.writeFileSync(created, "created")
    await createdObserved.released

    // then only the later creation is emitted
    expect(failures).toEqual([])
    expect(events).toEqual([{ path: created, filename: "c.md" }])
})

test("fileCreatedIn follows a symbolic link to a regular file", async () => {
    // given a directory containing a matching file link and a dangling link
    const { clankhouse } = tempClankHouse()
    const directory = tempDir("clankhouse-file-created-in-symlink-")
    const target = path.join(directory, "note.txt")
    const linked = path.join(directory, "result.md")
    fs.writeFileSync(target, "result")
    fs.symlinkSync(path.join(directory, "missing.txt"), path.join(directory, "00-dangling.md"))
    fs.symlinkSync(target, linked)

    // when a workflow waits for a matching file
    const result = await testRun(clankhouse, async () =>
        clankhouse.waitFor(fileCreatedIn(directory, { matching: "*.md" }))
    )

    // then the dangling link is ignored and the logical file-link path is returned
    expect(result).toEqual({ path: linked, filename: "result.md" })
})

test("fileCreatedIn detects a newly created matching direct file", async () => {
    // given a workflow watching a directory with no direct match
    const { clankhouse } = tempClankHouse()
    const directory = tempDir("clankhouse-file-created-in-new-")
    fs.mkdirSync(path.join(directory, "nested"))
    fs.writeFileSync(path.join(directory, "nested", "ignored.md"), "nested")
    fs.writeFileSync(path.join(directory, "ignored.txt"), "text")
    const waiting = gate()
    const promise = testRun(clankhouse, async () => {
        waiting.release()
        return clankhouse.waitFor(fileCreatedIn(directory, { matching: "*.md" }))
    })
    await waiting.released

    // when a matching regular file is created directly in the watched directory
    const target = path.join(directory, "created.md")
    fs.writeFileSync(target, "created")

    // then the wait resolves with its absolute path and basename
    expect(await promise).toEqual({ path: target, filename: "created.md" })
})

test("file sources emit newly observed paths while retaining present paths", async () => {
    // given target and directory sources watching the same initially empty directory
    const directory = tempDir("clankhouse-file-created-multiple-")
    const first = path.join(directory, "a.md")
    const second = path.join(directory, "b.md")
    const third = path.join(directory, "c.md")
    const targetEvents: Array<{ path: string; filename: string }> = []
    const directoryEvents: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const targetCreated = gate()
    const directoryCreated = gate()
    const directorySecond = gate()
    const directoryThird = gate()
    const fail = (error: unknown) => {
        failures.push(error)
        targetCreated.release()
        directoryCreated.release()
        directorySecond.release()
        directoryThird.release()
    }
    const targetHandle = fileCreated(first).start({
        emit(event) {
            targetEvents.push(event)
            if (targetEvents.length === 1) targetCreated.release()
        },
        fail
    })
    const directoryHandle = fileCreatedIn(directory, { matching: "*.md" }).start({
        emit(event) {
            directoryEvents.push(event)
            if (directoryEvents.length === 1) directoryCreated.release()
            if (directoryEvents.length === 2) directorySecond.release()
            if (directoryEvents.length === 3) directoryThird.release()
        },
        fail
    })
    onTestFinished(() => {
        targetHandle.stop()
        directoryHandle.stop()
    })

    // when three matching files are created across separate observations
    fs.writeFileSync(first, "first")
    await Promise.all([targetCreated.released, directoryCreated.released])
    fs.writeFileSync(second, "second")
    await directorySecond.released
    fs.writeFileSync(third, "third")
    await directoryThird.released

    // then each source emits newly observed paths without repeating paths that remained present
    expect(failures).toEqual([])
    expect(targetEvents).toEqual([{ path: first, filename: "a.md" }])
    expect(directoryEvents).toEqual([
        { path: first, filename: "a.md" },
        { path: second, filename: "b.md" },
        { path: third, filename: "c.md" }
    ])
})

test("fileCreatedIn may coalesce or observe a delete and re-create between scans", async () => {
    // given a source that has observed an existing file
    const directory = tempDir("clankhouse-file-created-coalesced-")
    const recreated = path.join(directory, "a.md")
    const later = path.join(directory, "b.md")
    fs.writeFileSync(recreated, "first")
    const events: Array<{ path: string; filename: string }> = []
    const failures: unknown[] = []
    const initialObserved = gate()
    const laterObserved = gate()
    const handle = fileCreatedIn(directory, { matching: "*.md" }).start({
        emit(event) {
            events.push(event)
            if (event.path === recreated) initialObserved.release()
            if (event.path === later) laterObserved.release()
        },
        fail(error) {
            failures.push(error)
            initialObserved.release()
            laterObserved.release()
        }
    })
    onTestFinished(() => handle.stop())
    await initialObserved.released

    // when the observed file is deleted and re-created synchronously before another change
    fs.unlinkSync(recreated)
    fs.writeFileSync(recreated, "second")
    fs.writeFileSync(later, "later")
    await laterObserved.released

    // then the recreation may be coalesced or emitted again when its absence was observed
    expect(failures).toEqual([])
    const recreatedEvent = { path: recreated, filename: "a.md" }
    const laterEvent = { path: later, filename: "b.md" }
    expect([
        [recreatedEvent, laterEvent],
        [recreatedEvent, recreatedEvent, laterEvent]
    ]).toContainEqual(events)
})

test("file sources require watched paths to resolve to directories", async () => {
    // given an absent directory, a regular file, and a symbolic link to an existing directory
    const { clankhouse } = tempClankHouse()
    const parent = tempDir("clankhouse-file-created-invalid-")
    const missing = path.join(parent, "missing")
    const file = path.join(parent, "file")
    const existing = path.join(parent, "existing")
    const linked = path.join(parent, "linked")
    fs.writeFileSync(file, "not a directory")
    fs.mkdirSync(existing)
    fs.writeFileSync(path.join(existing, "result.md"), "result")
    fs.symlinkSync(existing, linked)

    // when workflows start file sources against those directories
    const missingFile = testRun(
        clankhouse,
        async () => clankhouse.waitFor(fileCreated(path.join(missing, "file.md"))),
        {
            key: "missing-file"
        }
    )
    const missingDirectory = testRun(clankhouse, async () => clankhouse.waitFor(fileCreatedIn(missing)), {
        key: "missing-directory"
    })
    const regularFile = testRun(clankhouse, async () => clankhouse.waitFor(fileCreatedIn(file)), {
        key: "regular-file"
    })
    const linkedDirectory = testRun(clankhouse, async () => clankhouse.waitFor(fileCreatedIn(linked)))

    // then absent directories retain the native filesystem error
    await expect(missingFile).rejects.toMatchObject({ code: "ENOENT" })
    await expect(missingDirectory).rejects.toMatchObject({ code: "ENOENT" })
    // and a path resolving to a non-directory is rejected explicitly
    await expect(regularFile).rejects.toThrow(/requires a directory/)
    // and a symbolic-link directory is followed while retaining its logical path
    await expect(linkedDirectory).resolves.toEqual({ path: path.join(linked, "result.md"), filename: "result.md" })
})
