import { defineConfig } from "vitest/config"
import { testDefaults } from "./vitest.shared"

export default defineConfig({
    test: {
        ...testDefaults,
        include: [
            "core/tests/**/*.test.ts",
            "claude/tests/**/*.test.ts",
            "server/tests/**/*.test.ts",
            "cli/tests/**/*.test.ts"
        ]
    }
})
