// dispatch E2E — shared helpers for the Phase 2 terminal panel specs.
//
// Phase 2 retired the Spike #1 right-panel `terminal` mode (visual spec §0,
// OQ-4). The bottom-slide-up / dock-right `TerminalPanel` mounts unconditionally
// in `TicketDetailPage.tsx`. These helpers drive that surface — no Companion
// PTY round-trip is required for most assertions (the WS times out into a
// `.term-fail` state in CI, which is the deterministic surface under test).
//
// Where a spec needs PTY-shape behavior (drag-resize fit, multi-PTY pointer,
// launcher writes), the helpers expose a tiny mock transport you inject into
// `<TerminalPanel transport={...} />` — but TicketDetailPage doesn't expose
// that prop, so we drive the dev-only `window.__dispatchTerminal` helper that
// the panel installs (see TerminalPanel.tsx).
//
// CRITICAL — these helpers never start a real Companion. CI has no `claude`
// auth and no interactive shell; the Phase 2 panel's failure state (or its
// `.term-fail` Open-a-shell affordance) is the deterministic UI under test.

import { Page, Locator, expect } from "@playwright/test";

/** Default ticket the fixture-fallback path in TicketDetailPage falls back to. */
export const FIXTURE_DISPLAY_ID = "DSP-2876";

/**
 * Navigate to a ticket and wait for the panel surface to mount. The
 * `.term-panel-bottom` (or `.term-panel-right`) host is the marker the panel
 * has mounted; the `.tlist` strip is the marker the ticket detail rendered.
 *
 * The default panel position is `bottom`. Tests that need `right` toggle via
 * the toolbar's `Toggle panel position` button (or via Settings).
 */
export async function mountTerminalPanel(
  page: Page,
  ticketId: string = FIXTURE_DISPLAY_ID
): Promise<Locator> {
  await page.goto(`/t/${ticketId}`);
  await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });
  // TerminalPanel mounts on ticket-route enter, default position = bottom.
  // It only returns null when panel.state.open is false; localStorage hydrates
  // that flag, which is empty on first visit → open per `usePanelState` default.
  const panel = page.locator('[data-testid="terminal-panel"]');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  return panel;
}

/** Read the panel's current position class (`bottom` or `right`). */
export async function getPanelPosition(
  page: Page
): Promise<"bottom" | "right" | null> {
  const panel = page.locator('[data-testid="terminal-panel"]');
  const className = (await panel.getAttribute("class")) ?? "";
  if (className.includes("term-panel-bottom")) return "bottom";
  if (className.includes("term-panel-right")) return "right";
  return null;
}

/** Read the dev-only `__dispatchTerminal.activePtyId` via page.evaluate. */
export async function getActivePtyId(page: Page): Promise<string | null> {
  return await page.evaluate<string | null>(() => {
    const w = window as unknown as {
      __dispatchTerminal?: { activePtyId: string | null };
    };
    return w.__dispatchTerminal?.activePtyId ?? null;
  });
}

/** Read the dev-only `__dispatchTerminal.ptyList`. */
export async function getPtyList(page: Page): Promise<readonly string[]> {
  return await page.evaluate<readonly string[]>(() => {
    const w = window as unknown as {
      __dispatchTerminal?: { ptyList: readonly string[] };
    };
    return w.__dispatchTerminal?.ptyList ?? [];
  });
}

/** Invoke `__dispatchTerminal.openExtraPty(ticketId)` via page.evaluate. */
export async function openExtraPty(
  page: Page,
  ticketId: string = FIXTURE_DISPLAY_ID
): Promise<void> {
  await page.evaluate<unknown, string>((tid) => {
    const w = window as unknown as {
      __dispatchTerminal?: { openExtraPty: (t: string) => void };
    };
    w.__dispatchTerminal?.openExtraPty(tid);
  }, ticketId);
}

/**
 * Force a WebGL context loss on the xterm canvas via the
 * `WEBGL_lose_context.loseContext()` extension. AC A6.
 *
 * Returns true if the loss was triggered; false if no canvas / no extension.
 */
export async function forceWebglContextLoss(page: Page): Promise<boolean> {
  return await page.evaluate<boolean>(() => {
    // xterm WebglAddon mounts a <canvas> inside the .xterm-screen element.
    const canvas = document.querySelector(".xterm-host canvas") as
      | HTMLCanvasElement
      | null;
    if (!canvas) return false;
    const ctx = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!ctx) return false;
    const ext = (ctx as WebGLRenderingContext).getExtension(
      "WEBGL_lose_context"
    );
    if (!ext) return false;
    (ext as { loseContext: () => void }).loseContext();
    return true;
  });
}

/**
 * Read the current `activeRenderer` via the imperative TerminalHandle exposed
 * by the panel — only works in DEV builds (the dev-only window helper). The
 * webgl-fallback spec relies on this signal flipping `webgl` → `canvas`.
 *
 * The TerminalPanel exposes `term` (the xterm Terminal instance) but not the
 * activeRenderer directly via window. The most reliable signal we can
 * synchronously observe is the canvas-element layer — WebGL mounts a single
 * <canvas> inside `.xterm-host`; the Canvas fallback mounts its own canvases.
 * The flag is captured into the xterm instance via the addon refs; here we
 * count canvases as a sanity proxy AND inspect the dev-only DOM hint.
 */
export async function getActiveRendererHint(
  page: Page
): Promise<"webgl" | "canvas" | "dom" | "unknown"> {
  return await page.evaluate<"webgl" | "canvas" | "dom" | "unknown">(() => {
    const host = document.querySelector(".xterm-host");
    if (!host) return "unknown";
    // The WebglAddon adds a <canvas> with class `xterm-webgl-renderer-layer`
    // (xterm 5.x naming) — and xterm@6 keeps a single canvas inside the
    // .xterm-screen layer for the WebGL path. The CanvasAddon adds DIFFERENT
    // canvases (one per layer — base, link, selection). Count them.
    const canvases = host.querySelectorAll("canvas");
    if (canvases.length === 0) return "dom";
    // WebGL: a single canvas. Canvas addon: multiple canvases.
    if (canvases.length >= 3) return "canvas";
    return "webgl";
  });
}

/**
 * Drag the panel splitter by `(dx, dy)` pixels. Uses Playwright's pointer
 * primitives (pointerdown → pointermove → pointerup) so the panel sees
 * pointer-capture events the same way a user mouse drag fires.
 *
 * Returns the panel's bounding-box height/width before AND after the drag so
 * tests can assert the delta moved.
 */
export async function dragSplitter(
  page: Page,
  axis: "ns" | "ew",
  delta: number
): Promise<{
  before: { width: number; height: number };
  after: { width: number; height: number };
}> {
  const panel = page.locator('[data-testid="terminal-panel"]');
  const splitter = page.locator('[data-testid="terminal-splitter"]');
  await expect(splitter).toBeVisible();

  const before = await panel.boundingBox();
  if (!before) throw new Error("panel not visible");

  const splitterBox = await splitter.boundingBox();
  if (!splitterBox) throw new Error("splitter not visible");

  // Grab point: for the bottom panel the splitter sits at y=-3..+3 above the
  // panel, so center is safely above the stage. For the right panel the
  // splitter is at x=-3..+3 of the panel's left edge — the stage starts at
  // x=0 of the panel and OVERLAPS the right half of the splitter, so we must
  // grab from the LEFT half (x = splitter.x + 1.5px) to avoid pointer-events
  // landing on the stage instead.
  const startX =
    axis === "ew"
      ? splitterBox.x + splitterBox.width / 4
      : splitterBox.x + splitterBox.width / 2;
  const startY = splitterBox.y + splitterBox.height / 2;

  // Move-by axis: ns drags vertically; ew drags horizontally.
  // For bottom panel: dragging UP (negative dy) GROWS the panel (the splitter
  // is at the TOP edge; moving it up enlarges the dock).
  // For right panel: dragging LEFT (negative dx) GROWS the panel.
  const dx = axis === "ew" ? delta : 0;
  const dy = axis === "ns" ? delta : 0;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move in small steps so the rAF-throttled fit fires (visual spec §8).
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
  }
  await page.mouse.up();

  // Brief wait for the final fit() + state.
  await page.waitForTimeout(120);

  const after = await panel.boundingBox();
  if (!after) throw new Error("panel disappeared after drag");
  return {
    before: { width: before.width, height: before.height },
    after: { width: after.width, height: after.height },
  };
}

/**
 * Install a Playwright route handler that captures every POST to the launcher
 * audit endpoint. The captured array survives across page reloads inside the
 * test; consumer asserts shape + headers.
 */
export interface CapturedAuditPost {
  url: string;
  body: { ticket_display_id?: string; command_hash?: string; label?: string };
  headers: Record<string, string>;
}

export async function interceptAuditPost(
  page: Page
): Promise<{
  captured: CapturedAuditPost[];
  unroute: () => Promise<void>;
}> {
  const captured: CapturedAuditPost[] = [];
  await page.route("**/api/audit/launcher-fired", async (route) => {
    const req = route.request();
    const headers = req.headers();
    let body: CapturedAuditPost["body"] = {};
    try {
      body = JSON.parse(req.postData() ?? "{}") as CapturedAuditPost["body"];
    } catch {
      /* invalid JSON */
    }
    captured.push({ url: req.url(), body, headers });
    // Fulfill 204 No Content so the launcher fire-and-forget doesn't fail noisily.
    await route.fulfill({ status: 204, body: "" });
  });
  return {
    captured,
    unroute: async () => {
      await page.unroute("**/api/audit/launcher-fired");
    },
  };
}

/** Wait for `__dispatchTerminal` to be installed on window. */
export async function waitForDispatchTerminal(
  page: Page,
  timeoutMs = 5_000
): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __dispatchTerminal?: unknown };
      return w.__dispatchTerminal !== undefined;
    },
    undefined,
    { timeout: timeoutMs }
  );
}
