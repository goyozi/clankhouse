import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, link, lstat, open, readFile, unlink } from "node:fs/promises"
import * as path from "node:path"
import { isNodeError } from "@clankhouse/core/util"

type Credentials = {
    version: 1
    apiKey: string
}

export async function resolveCredentials(clankhouseDir: string): Promise<{ apiKey: string; file: string }> {
    const file = path.join(clankhouseDir, "credentials.json")
    try {
        const credentials = await readCredentials(file)
        return { apiKey: credentials.apiKey, file }
    } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error
    }

    const credentials: Credentials = { version: 1, apiKey: randomBytes(32).toString("base64url") }
    const temporary = path.join(clankhouseDir, `.credentials-${process.pid}-${randomBytes(8).toString("hex")}.tmp`)
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
        await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`)
        await handle.sync()
    } finally {
        await handle.close()
    }

    try {
        await link(temporary, file)
    } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error
    } finally {
        await unlink(temporary).catch(() => {})
    }

    const stored = await readCredentials(file)
    return { apiKey: stored.apiKey, file }
}

async function readCredentials(file: string): Promise<Credentials> {
    const stat = await lstat(file)
    if (!stat.isFile()) throw new Error("ClankHouse credentials must be a regular file")
    await chmod(file, 0o600)
    let parsed: unknown
    try {
        parsed = JSON.parse(await readFile(file, "utf8"))
    } catch {
        throw new Error("ClankHouse credentials file is malformed")
    }
    if (!isCredentials(parsed)) throw new Error("ClankHouse credentials file is malformed")
    return parsed
}

function isCredentials(value: unknown): value is Credentials {
    if (typeof value !== "object" || value === null) return false
    const candidate = value as Record<string, unknown>
    if (candidate.version !== 1 || typeof candidate.apiKey !== "string") return false
    if (!/^[A-Za-z0-9_-]{43}$/.test(candidate.apiKey)) return false
    return Buffer.from(candidate.apiKey, "base64url").byteLength === 32
}
