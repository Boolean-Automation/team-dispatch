// dispatch E2E — Phase 2 terminal panel surface (A14 + A17).
//
// Covers:
//   - A14: panel mounts at bottom by default; dock-right toggle reflows layout.
//   - A17: panel lifecycle is ticket-scoped — opens on /t/<id> mount, unmounts
//     on route-leave. (Persistence-on-rebind is covered by S2's scrollback
//     unit tests; e2e asserts the DOM lifecycle is honored.)
//
// Auth: graceful-passthrough — no Clerk key → RequireAuth passes through.
// Fixture: /t/DSP-2876 (TicketDetailPage's fixture fallback path).
//
// Note: this spec drives ONLY the surface. The xterm renderer may or may not
// have mounted depending on whether a Companion is running (CI has none, so
// the panel renders the `.term-fail` state). The presence of the
// `.term-panel-bottom` / `.term-panel-right` host + its toolbar + the splitter
// is what we assert — those are the parts of A14 + A17 visible without a PTY.

import { test, expect } from "@playwright/test";
import {
  FIXTURE_DISPLAY_ID,
  getPanelPosition,
  mountTerminalPanel,
} from "./terminal-helpers.js";

test.describe("Terminal panel — A14 + A17 (bottom + dock-right + ticket-scoped)", () => {
  test("A14 — panel auto-mounts at the bottom on /t/<displayId>", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);

    // Default position is `bottom` (usePanelState fallback when no Clerk
    // metadata and no localStorage). Asserted via the position class.
    await expect(panel).toHaveClass(/term-panel-bottom/);

    // Toolbar row present.
    await expect(panel.locator(".term-bar")).toBeVisible();
    // Splitter present (the drag-resize handle).
    await expect(
      panel.locator('[data-testid="terminal-splitter"]')
    ).toBeVisible();
    // Stage wrapper present.
    await expect(panel.locator(".term-stage")).toBeVisible();
  });

  test("A14 — toggling to dock-right swaps the panel host class", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);
    expect(await getPanelPosition(page)).toBe("bottom");

    // The toolbar's position-toggle button has dynamic title "Move to right".
    const toggle = panel.locator('button[title="Move to right"]');
    await expect(toggle).toBeVisible();
    await toggle.click();

    // After toggling, the host class flips and the inverse-title button surfaces.
    await expect(panel).toHaveClass(/term-panel-right/);
    expect(await getPanelPosition(page)).toBe("right");
    await expect(
      panel.locator('button[title="Move to bottom"]')
    ).toBeVisible();
  });

  test("A14 — toggling twice returns to the bottom position", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);
    await panel.locator('button[title="Move to right"]').click();
    await expect(panel).toHaveClass(/term-panel-right/);
    await panel.locator('button[title="Move to bottom"]').click();
    await expect(panel).toHaveClass(/term-panel-bottom/);
  });

  test("A17 — panel unmounts when navigating away from the ticket route", async ({
    page,
  }) => {
    await mountTerminalPanel(page);

    // Navigate to a non-ticket route — the panel is mounted inside
    // `TicketDetailPage`, so React unmounts it on route change.
    await page.goto("/");
    await expect(page.locator('[data-testid="terminal-panel"]')).toHaveCount(0);
  });

  test("A17 — panel re-mounts on a fresh ticket navigation", async ({
    page,
  }) => {
    // Open → leave → open the same ticket. The panel host re-appears.
    await mountTerminalPanel(page);
    await page.goto("/");
    await expect(page.locator('[data-testid="terminal-panel"]')).toHaveCount(0);
    // Re-enter the same ticket.
    await page.goto(`/t/${FIXTURE_DISPLAY_ID}`);
    await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('[data-testid="terminal-panel"]')
    ).toBeVisible({ timeout: 10_000 });
  });

  test("A14 — close button on the toolbar hides the panel", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);
    const closeBtn = panel.locator('button[title="Close terminal"]');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    // Closing sets panel.state.open=false; the component returns null.
    await expect(page.locator('[data-testid="terminal-panel"]')).toHaveCount(0);
  });
});
