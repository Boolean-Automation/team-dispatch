// dispatch E2E — Density toggle
//
// Coverage: surface-map Surface 2 (density toggle), plan §Slice 1
//
// Phase-1 scope: verifies data-density="compact" is the default on <body>.
// If the UI exposes a toggle, flipping it changes to "comfortable".
//
// Auth: graceful-passthrough (no Clerk key).

import { test, expect } from "@playwright/test";

test.describe("Density toggle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".board")).toBeVisible({ timeout: 15_000 });
  });

  test('data-density="compact" is the default on <body>', async ({ page }) => {
    // The plan (§Slice 1) mandates compact as the default density
    const density = await page.locator("body").getAttribute("data-density");
    expect(density).toBe("compact");
  });

  test("density attribute is present on <body> (either compact or comfortable)", async ({ page }) => {
    const density = await page.locator("body").getAttribute("data-density");
    expect(["compact", "comfortable"]).toContain(density);
  });
});
