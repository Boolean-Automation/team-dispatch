import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

/** @type {import("eslint").Linter.FlatConfig[]} */
export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "dispatch/**",
      ".build-runs/**",
      ".learnings/**",
    ],
  },
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // FIX 9: headless-core boundary — web must never import core or db directly
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@dispatch/core", "@dispatch/core/*"],
              message:
                "web must not import @dispatch/core directly — use the API client instead.",
            },
            {
              group: ["@dispatch/db", "@dispatch/db/*"],
              message:
                "web must not import @dispatch/db directly — use the API client instead.",
            },
            {
              group: ["../../core/**", "../../../core/**", "../../../../core/**"],
              message:
                "web must not reach into core via relative path — use the API client instead.",
            },
            {
              group: ["../../db/**", "../../../db/**", "../../../../db/**"],
              message:
                "web must not reach into db via relative path — use the API client instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/**/*.{ts,tsx}"],
    ignores: ["packages/web/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {},
  },
];
