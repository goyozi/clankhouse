import { defineConfig } from "vitest/config"
import { testDefaults } from "../../vitest.shared"

export default defineConfig({
    test: {
        ...testDefaults,
        include: ["tests/**/*.test.ts"]
    }
})
