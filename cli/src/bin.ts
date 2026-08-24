#!/usr/bin/env node

import process from "node:process"
import { runCli } from "./index.js"

const controller = new globalThis.AbortController()
const abort = () => controller.abort(new globalThis.DOMException("Interrupted", "AbortError"))
process.once("SIGINT", abort)
try {
    process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal })
} finally {
    process.off("SIGINT", abort)
}
