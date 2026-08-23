import { createHash } from "node:crypto"
import { access } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { customAlphabet } from "nanoid"

export function resolveClankHouseDir(dir?: string): string {
    return dir ?? process.env.CLANKHOUSE_DIR ?? path.join(os.homedir(), ".clankhouse")
}

export async function exists(target: string): Promise<boolean> {
    try {
        await access(target)
        return true
    } catch {
        return false
    }
}

const idAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const generateId = customAlphabet(idAlphabet, 21)

export function newId(): string {
    return generateId()
}

export function nowIso(): string {
    return new Date().toISOString()
}

export function sanitize(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, "-")
}

export function uniqueName(value: string): string {
    const hash = createHash("sha256").update(value).digest("hex").slice(0, 8)
    return `${sanitize(value)}-${hash}`
}

export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code
}
