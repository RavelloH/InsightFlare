import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import noRelativeImportPaths from "eslint-plugin-no-relative-import-paths";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: [
      ".cache/**",
      ".output/**",
      ".playwright-cli/**",
      ".tanstack/**",
      ".wrangler/**",
      "dist/**",
      "node_modules/**",
      "output/**",
      "plan/**",
      "playwright-report/**",
      "test-results/**",
      ".tmp/**",
      "tmp/**",
      "src/routeTree.gen.ts",
      "src/tracker/**",
      "*.tsbuildinfo",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.strict,
  {
    plugins: {
      "no-relative-import-paths": noRelativeImportPaths,
      "react-hooks": reactHooks,
      "simple-import-sort": simpleImportSort,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-relative-import-paths/no-relative-import-paths": [
        "error",
        {
          allowSameFolder: true,
          rootDir: "src",
          prefix: "@",
        },
      ],
      "simple-import-sort/imports": [
        "error",
        {
          groups: [
            ["^\\u0000"],
            ["^node:"],
            ["^react", "^@?\\w"],
            ["^@/"],
            [
              "^\\.\\.(?!/?$)",
              "^\\.\\./?$",
              "^\\./(?=.*/)(?!/?$)",
              "^\\.(?!/?$)",
              "^\\./?$",
            ],
            ["^.+\\.s?css$"],
          ],
        },
      ],
      "simple-import-sort/exports": "error",
    },
  },
  {
    ...react.configs.flat.recommended,
    files: ["**/*.{jsx,tsx}"],
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
        },
      ],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.test.{ts,tsx,mts}", "**/__tests__/**/*.{ts,tsx,mts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: ["src/lib/realtime/mock/**"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
