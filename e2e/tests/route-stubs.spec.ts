// dispatch E2E — Route stubs: Settings and Analytics (Surfaces 4 & 5)
//
// Coverage: surface-map Surfaces 4 & 5
//
// Auth: graceful-passthrough (no Clerk key).
//
// Asserts:
//   - /settings renders the rail with Configure sub-nav (Triggers / Team & OOO / Connections / General)
//   - /settings has a topbar title "Settings"
//   - /settings does NOT render the full Trigger rule builder (deferred)
//   - /analytics renders the rail with Dashboards sub-nav (Overview / Workforce / SLA)
//   - /analytics has a topbar title "Analytics"
//   - /analytics does NOT render Phase-4 chart elements

import { test, expect } from "@playwright/test";

test.describe("Settings stub page (Surface 4)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
    // Wait for the rail to be visible
    await expect(page.locator(".rail")).toBeVisible({ timeout: 15_000 });
  });

  test("rail renders with Settings nav item highlighted and Configure sub-nav", async ({ page }) => {
    const rail = page.locator(".rail");
    await expect(rail).toBeVisible();

    // The Settings nav link uses class="nav-item active" when current="settings"
    // Look for the Settings nav item in the main nav section
    const settingsNavItem = rail.locator(".nav-item").filter({ hasText: /Settings/ }).first();
    await expect(settingsNavItem).toBeVisible();

    // The configure sub-nav is rendered because current="settings":
    // Triggers / Team & OOO / Connections / General
    // Use nav-item links (not section labels) to target the sub-nav items specifically
    await expect(rail.locator(".nav-item").filter({ hasText: "Triggers" }).first()).toBeVisible();
    await expect(rail.locator(".nav-item").filter({ hasText: /Team.*OOO/i }).first()).toBeVisible();
    // "Connections" appears in both the sub-nav link and as a section label; target the link
    await expect(rail.locator("a.nav-item").filter({ hasText: "Connections" }).first()).toBeVisible();
    await expect(rail.locator("a.nav-item").filter({ hasText: "General" }).first()).toBeVisible();
  });

  test("topbar shows Settings screen title", async ({ page }) => {
    const topbar = page.locator(".topbar");
    await expect(topbar).toBeVisible();

    // The SettingsPage renders a topbar stub with "Settings" title
    const screenTitle = topbar.locator(".screen-title");
    await expect(screenTitle).toBeVisible();
    await expect(screenTitle).toContainText("Settings");
  });

  test("does NOT render the full Trigger rule builder (deferred)", async ({ page }) => {
    // Phase-2+ elements that must be absent in Phase 1
    await expect(page.locator(".trig-list")).not.toBeVisible();
    await expect(page.locator(".trig-canvas")).not.toBeVisible();
    await expect(page.locator(".rule-stack")).not.toBeVisible();

    // Phase 2 / S5 lifted the Settings shell into a real 264px nav + tab
    // body. `/settings` redirects to `/settings/terminal` (the only enabled
    // tab in Phase 2); other tabs (Triggers / Team / Connections / Profile)
    // render as `.nav-item.is-stub` disabled — they REPLACED the Phase-1
    // "coming in a later phase" full-page placeholder. Asserting the stub
    // items proves the deferred-Trigger-builder posture is intact.
    await expect(
      page.locator('[data-testid="settings-nav-triggers"]')
    ).toHaveClass(/is-stub/);
    await expect(
      page.locator('[data-testid="settings-nav-team"]')
    ).toHaveClass(/is-stub/);
  });
});

test.describe("Analytics stub page (Surface 5)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/analytics");
    // Wait for the rail to be visible
    await expect(page.locator(".rail")).toBeVisible({ timeout: 15_000 });
  });

  test("rail renders with Analytics nav item highlighted and Dashboards sub-nav", async ({ page }) => {
    const rail = page.locator(".rail");
    await expect(rail).toBeVisible();

    // The Analytics nav item should be in the rail
    const analyticsNavItem = rail.locator(".nav-item").filter({ hasText: /Analytics/ }).first();
    await expect(analyticsNavItem).toBeVisible();

    // Dashboards sub-nav: Overview / Workforce / SLA (rendered when current="analytics")
    // Use nav-item links to be specific — "SLA" is a link, "Slack" is a connection label
    await expect(rail.locator("a.nav-item").filter({ hasText: "Overview" }).first()).toBeVisible();
    await expect(rail.locator("a.nav-item").filter({ hasText: "Workforce" }).first()).toBeVisible();
    // Use exact label text in a nav-item — not the "Slack" connection item
    await expect(rail.locator("a.nav-item").filter({ hasText: /^SLA$/ }).first()).toBeVisible();
  });

  test("topbar shows Analytics screen title", async ({ page }) => {
    const topbar = page.locator(".topbar");
    await expect(topbar).toBeVisible();

    const screenTitle = topbar.locator(".screen-title");
    await expect(screenTitle).toBeVisible();
    await expect(screenTitle).toContainText("Analytics");
  });

  test("does NOT render Phase-4 chart elements (charts deferred to Phase 4)", async ({ page }) => {
    // Phase-4 elements must not be present
    await expect(page.locator(".chart-card")).not.toBeVisible();
    await expect(page.locator(".chart-svg")).not.toBeVisible();
    await expect(page.locator(".bar-rect")).not.toBeVisible();

    // Phase-1 placeholder text
    await expect(page.getByText(/coming in Phase 4/i)).toBeVisible();
  });
});
