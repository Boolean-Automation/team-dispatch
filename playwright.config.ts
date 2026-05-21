// dispatch — Playwright E2E configuration
//
// Auth strategy: graceful-passthrough — no VITE_CLERK_PUBLISHABLE_KEY is set,
// so RequireAuth passes every visitor through without a Clerk sign-in.
// The rail footer renders the seeded "Dan" identity.
// See e2e/README.md for details.
//
// webServer setup:
//   - Vite dev server (port 5173) — always started.
//   - API server (port 3000) — started for board tests that need live data.
//     DATABASE_URL is always pointed at dispatch_dev (never dispatch_test).

import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_PORT = 5173;
const API_PORT = 3000;

export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: false, // run serially to avoid port conflicts
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "e2e/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
    screenshot: "on",
    // give SPA enough time to hydrate on first load
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // ── webServer: Vite (+ API for board tests) ──────────────────────────────────
  //
  // We start both servers unconditionally; the board test needs the API,
  // while the fixture-only tests work with the Vite server alone.
  // The API server exits cleanly when Playwright finishes.
  webServer: [
    {
      // Vite dev server — NO VITE_CLERK_PUBLISHABLE_KEY → graceful-passthrough
      command: "pnpm --filter @dispatch/web dev",
      url: `http://localhost:${WEB_PORT}`,
      cwd: path.resolve(__dirname),
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        // Explicitly unset Clerk key → graceful-passthrough mode
        VITE_CLERK_PUBLISHABLE_KEY: "",
      },
    },
    {
      // API server — always uses dispatch_dev, never dispatch_test
      command: "pnpm --filter @dispatch/api dev",
      url: `http://localhost:${API_PORT}/api/tickets`,
      cwd: path.resolve(__dirname),
      reuseExistingServer: true,
      timeout: 60_000,
      ignoreHTTPSErrors: true,
      env: {
        DATABASE_URL: "postgresql://cody@localhost:5432/dispatch_dev",
        CLERK_SECRET_KEY: "",
        PORT: String(API_PORT),
        NODE_ENV: "development",
      },
    },
  ],

  outputDir: "e2e/test-results",
});
