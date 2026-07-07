import js from "@eslint/js"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier"

export default tseslint.config(
    {
        ignores: ["node_modules/", "scratchpad/"]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ["eslint.config.js", "vitest.config.ts"]
                },
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "no-empty": ["error", { allowEmptyCatch: true }]
        }
    },
    prettier
)
