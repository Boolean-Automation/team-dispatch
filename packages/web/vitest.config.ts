import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @xterm/addon-ligatures ships only an .mjs but declares `main: lib/addon-ligatures.js`.
      // Vite's prod build resolves via `module:` field but vitest's default
      // resolver picks `main:` first, which doesn't exist on disk. Point it
      // directly at the .mjs to keep imports working under the test runner.
      "@xterm/addon-ligatures":
        "@xterm/addon-ligatures/lib/addon-ligatures.mjs",
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
