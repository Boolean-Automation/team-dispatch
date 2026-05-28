// dispatch E2E — Account Highlights panel (Fix 4, AC-4)
//
// Packet §AC-4:
//   - With seeded highlights data → panel renders content.
//   - With null highlights → section absent from DOM.
//   - "No highlights yet" string DELETED from codebase — must never appear.
//
// Dev phase gate-dev.md commit 4feab5a shipped:
//   - Highlights.tsx new contract: { content, sourcePath, editedAt } | null
//   - null → component returns null (section absent, NOT a placeholder)
//   - "No highlights yet" JSX block DELETED
//
// FIXTURE_HIGHLIGHTS in ticket-detail-fixture.ts has content: "Pro Rise Painting…"
// The fixture path activates when: DEV mode + API error + displayId = DSP-2876.
// In the graceful-passthrough E2E setup (no Clerk, no API → 401), the fixture
// activates and FIXTURE_HIGHLIGHTS renders.
//
// Auth: graceful-passthrough (no Clerk key).
// Data: fixture path — /t/DSP-2876 (FIXTURE_HIGHLIGHTS has content).

import { test, expect } from "@playwright/test";

const FIXTURE_DISPLAY_ID = "DSP-2876";

test.describe("AC-4 — Account Highlights panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/t/${FIXTURE_DISPLAY_ID}`);
    await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });
  });

  test("highlights panel renders when fixture data is present", async ({ page }) => {
    // FIXTURE_HIGHLIGHTS.content: "Pro Rise Painting · 18 mo client…"
    // The Highlights component renders .highlights when content is non-null
    const highlightsPanel = page.locator(".highlights");
    await expect(highlightsPanel).toBeVisible({ timeout: 10_000 });

    // Header "Account highlights" must be present
    await expect(highlightsPanel.locator(".pin")).toContainText("Account highlights");

    // The body must contain non-empty content from the fixture
    const body = highlightsPanel.locator(".highlights-body");
    await expect(body).toBeVisible();
    const text = await body.textContent();
    expect(text?.trim().length).toBeGreaterThan(10);
  });

  test('"No highlights yet" string is absent from the DOM (AC-4 negative)', async ({ page }) => {
    // This string was DELETED in commit 4feab5a — must never appear anywhere on the page
    const fullText = await page.locator("body").textContent();
    expect(fullText).not.toContain("No highlights yet");
    expect(fullText).not.toContain("no highlights yet");
  });

  test("highlights panel is absent when highlights are null (null → DOM absent)", async ({ page }) => {
    // To test null state, navigate to a non-fixture display ID — API returns 401,
    // but since displayId !== DSP-2876, apiUnavailable is false, and accountHighlights
    // remains null (no fixture fallback). Component should return null (no .highlights div).
    //
    // Use a non-fixture display ID that doesn't match the fixture trigger condition.
    await page.goto("/t/DSP-XXXX-NULL-TEST");
    // Wait for the page structure to attempt to load
    await page.waitForTimeout(3000);

    // .highlights should NOT be present in the DOM
    const highlightsCount = await page.locator(".highlights").count();
    expect(highlightsCount).toBe(0);
  });

  test("highlights body does not use CSS line-clamp (a11y/copy-paste requirement)", async ({ page }) => {
    // Packet §ADR Code-level floors #8: CSS line-clamp forbidden (breaks copy-paste + screen readers)
    // Server-side truncation at 500 chars is used instead.
    const highlightsPanel = page.locator(".highlights");
    await expect(highlightsPanel).toBeVisible({ timeout: 10_000 });

    const hasLineClamp = await page.locator(".highlights-body").evaluate((el) => {
      const style = window.getComputedStyle(el);
      return (
        style.webkitLineClamp !== "none" &&
        style.webkitLineClamp !== "" &&
        style.webkitLineClamp !== "0" &&
        // @ts-ignore
        style["-webkit-line-clamp"] !== "none"
      );
    });
    expect(hasLineClamp).toBe(false);
  });
});
