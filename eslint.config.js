import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactPlugin from "eslint-plugin-react";

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
      react: reactPlugin,
    },
    rules: {
      // Slice 0 — SPA-wide security lint rules. CSP is defense-in-depth;
      // these rules close the source-code sinks that CSP would otherwise have
      // to catch at runtime. Any violation here fails CI before merge.
      "react/no-danger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "document",
          property: "write",
          message:
            "document.write is banned — it can execute attacker-controlled HTML.",
        },
        {
          property: "innerHTML",
          message:
            "innerHTML is banned outside explicit waivers — use textContent or React state.",
        },
        {
          property: "outerHTML",
          message: "outerHTML is banned — see innerHTML.",
        },
        {
          property: "insertAdjacentHTML",
          message: "insertAdjacentHTML is banned — see innerHTML.",
        },
      ],
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
              group: ["@dispatch/companion", "@dispatch/companion/*"],
              message:
                "web must not import @dispatch/companion — talk to the Companion only over the WebSocket; re-declare protocol types locally.",
            },
            {
              group: [
                "../../companion/**",
                "../../../companion/**",
                "../../../../companion/**",
              ],
              message:
                "web must not reach into the Companion package via relative path — talk to it over the WebSocket only.",
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
