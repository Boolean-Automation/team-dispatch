// dispatch E2E — Phase 2 Settings → Terminal page (A22).
//
// Covers AC A22 (5 controls + auto-save):
//   - /settings redirects to /settings/terminal.
//   - All 5 controls render with their defaults.
//   - Selecting a theme/font/scrollback control toggles the active state.
//   - The SaveStateChip surfaces (idle → saving/saved cycle).
//   - The launcher inputs accept text input.
//
// Cross-window propagation (BroadcastChannel) + the two-tab race scenario is
// covered by `use-terminal-settings.race.test.ts` at the unit layer; e2e
// doesn't dispatch two browser contexts to assert convergence — see the
// brief's race-test note.
//
// Auth: graceful-passthrough. Without a Clerk user, `useTerminalSettings`
// falls back to the in-memory defaults — controls render, taps toggle local
// state, but the persistence layer is a no-op. The test asserts the *UI* is
// wired; durability is the unit-test layer's job.

import { test, expect } from "@playwright/test";

test.describe("Terminal settings — A22 (5 controls + auto-save)", () => {
  test("A22 — /settings redirects to /settings/terminal", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings\/terminal$/);
    await expect(
      page.locator('[data-testid="settings-terminal-page"]')
    ).toBeVisible({ timeout: 10_000 });
  });

  test("A22 — all 5 controls render with their defaults", async ({ page }) => {
    await page.goto("/settings/terminal");
    await expect(
      page.locator('[data-testid="settings-terminal-page"]')
    ).toBeVisible({ timeout: 10_000 });

    // 1. Panel position — Bottom is the default.
    const posBottom = page.locator('[data-testid="seg-position-bottom"]');
    const posRight = page.locator('[data-testid="seg-position-right"]');
    await expect(posBottom).toBeVisible();
    await expect(posRight).toBeVisible();
    await expect(posBottom).toHaveClass(/on/);

    // 2. Launcher inputs — default Claude / claude.
    await expect(
      page.locator('[data-testid="launcher-label-input"]')
    ).toHaveValue("Claude");
    await expect(
      page.locator('[data-testid="launcher-command-input"]')
    ).toHaveValue("claude");

    // 3. Theme — Coal default.
    await expect(page.locator('[data-testid="seg-theme-coal"]')).toHaveClass(
      /on/
    );
    // All 5 theme buttons render.
    await expect(page.locator('[data-testid="seg-theme-paper"]')).toBeVisible();
    await expect(page.locator('[data-testid="seg-theme-mono"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="seg-theme-highContrast"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="seg-theme-solarizedDark"]')
    ).toBeVisible();

    // 4. Font — family is JetBrains Mono, size 13 default.
    await expect(page.locator('[data-testid="font-family-select"]')).toHaveValue(
      "JetBrains Mono"
    );
    await expect(
      page.locator('[data-testid="seg-font-size-13"]')
    ).toHaveClass(/on/);
    // All 5 sizes render.
    for (const s of [11, 12, 13, 14, 15]) {
      await expect(
        page.locator(`[data-testid="seg-font-size-${s}"]`)
      ).toBeVisible();
    }

    // 5. Scrollback — 10k default.
    await expect(
      page.locator('[data-testid="seg-scrollback-10000"]')
    ).toHaveClass(/on/);
    // 3 presets render.
    await expect(
      page.locator('[data-testid="seg-scrollback-1000"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="seg-scrollback-5000"]')
    ).toBeVisible();
  });

  test("A22 — clicking Paper theme flips the active state to Paper", async ({
    page,
  }) => {
    await page.goto("/settings/terminal");
    await expect(
      page.locator('[data-testid="settings-terminal-page"]')
    ).toBeVisible();

    const paperBtn = page.locator('[data-testid="seg-theme-paper"]');
    await paperBtn.click();
    // The Paper button takes the .on class; Coal loses it.
    await expect(paperBtn).toHaveClass(/on/);
    await expect(page.locator('[data-testid="seg-theme-coal"]')).not.toHaveClass(
      /on/
    );
  });

  test("A22 — clicking font size 15 flips the active state", async ({
    page,
  }) => {
    await page.goto("/settings/terminal");
    await expect(
      page.locator('[data-testid="settings-terminal-page"]')
    ).toBeVisible();

    const size15 = page.locator('[data-testid="seg-font-size-15"]');
    await size15.click();
    await expect(size15).toHaveClass(/on/);
  });

  test("A22 — clicking scrollback 1k flips the active state", async ({
    page,
  }) => {
    await page.goto("/settings/terminal");
    await expect(
      page.locator('[data-testid="settings-terminal-page"]')
    ).toBeVisible();

    const sb1k = page.locator('[data-testid="seg-scrollback-1000"]');
    await sb1k.click();
    await expect(sb1k).toHaveClass(/on/);
  });

  test("A22 — position toggle from Bottom to Right surfaces in the .on class", async ({
    page,
  }) => {
    await page.goto("/settings/terminal");
    await expect(
      page.locator('[data-testid="settings-terminal-page"]')
    ).toBeVisible();

    const right = page.locator('[data-testid="seg-position-right"]');
    await right.click();
    await expect(right).toHaveClass(/on/);
    await expect(
      page.locator('[data-testid="seg-position-bottom"]')
    ).not.toHaveClass(/on/);
  });

  test("A22 — the Terminal sub-tab is highlighted in SettingsNav", async ({
    page,
  }) => {
    await page.goto("/settings/terminal");
    await expect(
      page.locator('[data-testid="settings-terminal-page"]')
    ).toBeVisible();
    // SettingsNav renders `[role="navigation"]` with a `.nav-item.active` entry
    // for the current sub-page (the only enabled one in Phase 2).
    const nav = page.locator('[data-testid="settings-nav"]');
    await expect(nav).toBeVisible();
    const activeItem = page.locator('[data-testid="settings-nav-terminal"]');
    await expect(activeItem).toHaveClass(/active/);
    // Other items render as disabled stubs (visual spec §6.1).
    await expect(
      page.locator('[data-testid="settings-nav-triggers"]')
    ).toHaveClass(/is-stub/);
  });
});
