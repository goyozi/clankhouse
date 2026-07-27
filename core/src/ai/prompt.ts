import { readFile, stat } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import Handlebars from "handlebars"
import { exists } from "../util"

/**
 * Prompt can be passed directly or read from a file.
 *
 * Relative file paths are resolved against:
 * - the nearest parent containing package.json, starting from the working directory
 * - current working directory if parent containing package.json is not found
 *
 * If vars is provided, the file is rendered as a Handlebars template.
 *
 * File URLs allow templates to be part of npm packages: `file: new URL(path, import.meta.url)`
 */
export type Prompt = string | { file: string | URL; vars?: any }

type CachedTemplate = {
    mtimeMs: number
    content: string
    compiled?: HandlebarsTemplateDelegate
}

const templates = new Map<string, CachedTemplate>()
const projectRoots = new Map<string, string>()

export async function renderPrompt(prompt: Prompt): Promise<string> {
    if (typeof prompt === "string") return prompt
    const file =
        prompt.file instanceof URL
            ? fileURLToPath(prompt.file)
            : path.isAbsolute(prompt.file)
              ? prompt.file
              : path.join(await projectRoot(), prompt.file)
    const cached = await loadTemplate(file)
    if (prompt.vars === undefined) return cached.content
    cached.compiled ??= Handlebars.compile(cached.content, { noEscape: true })
    return cached.compiled(prompt.vars)
}

async function loadTemplate(file: string): Promise<CachedTemplate> {
    const { mtimeMs } = await stat(file)
    const cached = templates.get(file)
    if (cached && cached.mtimeMs === mtimeMs) return cached
    const fresh: CachedTemplate = { mtimeMs, content: await readFile(file, "utf8") }
    templates.set(file, fresh)
    return fresh
}

async function projectRoot(): Promise<string> {
    const cwd = process.cwd()
    const cached = projectRoots.get(cwd)
    if (cached !== undefined) return cached
    const root = await findProjectRoot(cwd)
    projectRoots.set(cwd, root)
    return root
}

async function findProjectRoot(cwd: string): Promise<string> {
    let dir = cwd
    while (true) {
        if (await exists(path.join(dir, "package.json"))) return dir
        const parent = path.dirname(dir)
        // path.dirname returns its input unchanged at the filesystem root ("/" on POSIX,
        // drive and UNC roots on Windows), so parent === dir detects reaching the root
        if (parent === dir) return cwd
        dir = parent
    }
}
