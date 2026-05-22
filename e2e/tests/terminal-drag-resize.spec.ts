// dispatch E2E — Phase 2 drag-resize (A15).
//
// Covers AC A15:
//   - The splitter resizes the panel continuously during drag.
//   - Min/max clamping is enforced.
//   - Both bottom (ns) and right (ew) axes work.
//
// The rAF-throttled fit + 0.55 fits/pointermove behavior is unit-tested in
// `packages/web/src/terminal/use-drag-resize.test.ts`. This e2e asserts the
// user-visible behavior — the panel's bounding box changes after a drag.
//
// Note: the splitter sits at the TOP edge of a bottom-docked panel (drag UP =
// grow) and the LEFT edge of a right-docked panel (drag LEFT = grow). The
// helper converts axis + delta accordingly.

import { test, expect } from "@playwright/test";
import {
  dragSplitter,
  getPanelPosition,
  mountTerminalPanel,
} from "./terminal-helpers.js";

test.describe("Terminal drag-resize — A15", () => {
  test("A15 bottom — dragging the splitter up grows the panel height", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);
    expect(await getPanelPosition(page)).toBe("bottom");

    // Drag UP (negative dy) → for the bottom panel that GROWS the height.
    const { before, after } = await dragSplitter(page, "ns", -200);

    // Height should have GROWN. Allow generous tolerance — the actual delta
    // depends on the splitter origin + clamps, but the panel must measurably
    // change.
    expect(after.height).toBeGreaterThan(before.height + 50);
    // Width should be (nearly) unchanged — bottom panel resizes the height axis.
    expect(Math.abs(after.width - before.width)).toBeLessThan(20);
  });

  test("A15 right — dragging the splitter left grows the panel width", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);
    // Flip to dock-right.
    await panel.locator('button[title="Move to right"]').click();
    await expect(panel).toHaveClass(/term-panel-right/);

    // Drag LEFT (negative dx) → for the right panel that GROWS the width.
    const { before, after } = await dragSplitter(page, "ew", -200);

    expect(after.width).toBeGreaterThan(before.width + 50);
    // Height should be (nearly) unchanged.
    expect(Math.abs(after.height - before.height)).toBeLessThan(20);
  });

  test("A15 bottom — max clamp prevents the panel from exceeding 70vh", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    const maxAllowed = viewport.height * 0.7;

    // Attempt to drag UP by half the viewport — that's well above the 70vh cap.
    await dragSplitter(page, "ns", -Math.round(viewport.height * 0.9));

    const box = await panel.boundingBox();
    if (!box) throw new Error("panel missing");
    // The panel must NOT exceed 70vh — allow 8px slop for borders/transform.
    expect(box.height).toBeLessThanOrEqual(maxAllowed + 8);
  });

  test("A15 right — max clamp prevents the panel from exceeding 720px", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);
    await panel.locator('button[title="Move to right"]').click();
    await expect(panel).toHaveClass(/term-panel-right/);

    // Attempt to drag LEFT by a giant delta — well past the 720px cap.
    await dragSplitter(page, "ew", -1500);

    const box = await panel.boundingBox();
    if (!box) throw new Error("panel missing");
    expect(box.width).toBeLessThanOrEqual(720 + 8);
  });

  test("A15 bottom — min clamp prevents the panel from collapsing below 140px", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);

    // Drag DOWN (positive dy) → for the bottom panel that SHRINKS height.
    await dragSplitter(page, "ns", 1500);

    const box = await panel.boundingBox();
    if (!box) throw new Error("panel missing");
    // Min is 140px; allow 8px slop.
    expect(box.height).toBeGreaterThanOrEqual(140 - 8);
  });
});
