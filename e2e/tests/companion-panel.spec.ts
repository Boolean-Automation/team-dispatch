// dispatch E2E — Spike #1 companion-panel (RETIRED in Phase 2 / Slice 3).
//
// The Spike #1 right-panel `terminal` mode (`PanelTerminal` rendered inside
// `RightPanel`) was DELIBERATELY RETIRED in Phase 2 per visual spec §0 / §11.3
// and OQ-4 — there is ONE terminal surface now, with two positions
// (bottom-slide-up default + dock-right), not two competing surfaces.
//
// Concretely: `RToolbar` lost its `claude-code` (Ic.terminal) button,
// `RightPanel` lost its `panel === "terminal"` branch, and `PanelMode`
// narrowed to `"info" | "activity"`. The Spike #1 PanelTerminal failure-block
// JSX was salvaged into `TerminalPanel.tsx` (visual spec §5.6 keeps the
// `.term-fail` CSS verbatim).
//
// What replaces this spec in Phase 2:
//   - `terminal-panel.spec.ts`  — A14 + A17 (bottom + dock-right + ticket-scoped).
//   - `terminal-drag-resize.spec.ts` — A15 (continuous drag + clamping).
//   - `terminal-popout.spec.ts` — A16 + Codex F4 (cap=1, opener-close, etc.).
//   - `terminal-launcher.spec.ts` — A23 + Codex F5 (launcher + consent + audit).
//   - `terminal-settings.spec.ts` — A22 (5 controls + auto-save).
//   - `terminal-multi-pty.spec.ts` — A21 + A18 (single-render UI + cap toast).
//   - `terminal-security.spec.ts` — A24 (CSP + helmet + same-origin policy).
//   - `terminal-webgl-fallback.spec.ts` — A6 (WebGL → Canvas swap).
//
// This file is kept (as a single docs-marker test) so CI history continues to
// track the file under its old name. Deleting it would remove the migration
// trail; keeping a passing breadcrumb test signals "intentionally retired,
// not silently dropped".

import { test, expect } from "@playwright/test";

test.describe("Companion panel — Spike #1 RETIRED (see terminal-*.spec.ts)", () => {
  test("retirement marker: the Spike #1 right-panel terminal mode is gone", async ({
    page,
  }) => {
    // The Phase 1 ticket layout still mounts the right-panel toolbar; the
    // `claude-code` button is gone. This single assertion is the load-bearing
    // signal: if the button comes back, this test fails and Phase 2's
    // OQ-4 retirement is being undone unintentionally.
    await page.goto("/t/DSP-2876");
    await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });
    const toolbar = page.locator(".r-toolbar");
    await expect(toolbar).toBeVisible();
    await expect(
      toolbar.locator("button[title='claude-code']")
    ).toHaveCount(0);
  });
});
