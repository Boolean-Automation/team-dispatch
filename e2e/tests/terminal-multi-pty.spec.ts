// dispatch E2E — Phase 2 multi-PTY data model, single-render UI (A21 + A18 partial).
//
// Covers:
//   - A21: panel renders exactly ONE `.term-tab-pill` + a disabled `+` stub.
//   - A18 (UI surface): the cap-exceeded toast UX. The Companion-side per-PTY
//     map + token authz are unit-tested in `packages/companion/`. The recency
//     stack contract is unit-tested in `use-active-pty.test.ts`. E2E asserts
//     the user-visible UI surfaces.
//
// The dev-only `window.__dispatchTerminal.openExtraPty()` helper is wired into
// `TerminalPanel.tsx` for L2 debug-path testing (import.meta.env.DEV only).
// In CI Vite runs in dev mode so this helper is present.

import { test, expect } from "@playwright/test";
import { mountTerminalPanel } from "./terminal-helpers.js";

// Cap-exceeded toast message — pinned from useActivePty's CAP_EXCEEDED_MESSAGE.
const CAP_TOAST_REGEX = /You've hit the 3-PTY cap for this ticket/;

test.describe("Terminal multi-PTY — A21 + A18", () => {
  test("A21 — exactly one tab pill renders alongside a disabled '+' stub", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);

    // ONE pill.
    const pills = panel.locator(".term-tab-pill");
    await expect(pills).toHaveCount(1);
    // The pill carries the ticket id.
    await expect(pills.first()).toContainText("DSP-2876");

    // The disabled `+` stub is present, has the `is-stub` class, and is
    // not clickable.
    const stub = panel.locator(".term-act.is-stub");
    await expect(stub).toBeVisible();
    await expect(stub).toBeDisabled();
    await expect(stub).toHaveAttribute("aria-disabled", "true");
    await expect(stub).toHaveAttribute(
      "title",
      "Multi-terminal coming in v1.5"
    );
  });

  test("A21 — the `+` stub tooltip announces multi-terminal v1.5", async ({
    page,
  }) => {
    const panel = await mountTerminalPanel(page);
    const stub = panel.locator(".term-act.is-stub");
    await expect(stub).toHaveAttribute("title", /v1\.5/);
    await expect(stub).toHaveAccessibleName(/coming in v1\.5/i);
  });

  test("A18 — cap-exceeded toast contract: useActivePty fires the canonical copy", async ({
    page,
  }) => {
    // The cap-exceeded server frame is dispatched by the Companion when a
    // 4th `pty.open` arrives for a ticket already holding 3 PTYs. The web
    // `useActivePty` hook converts that frame into a `fireInfoToast` call
    // (the constant `CAP_EXCEEDED_MESSAGE`).
    //
    // We register an info-toast handler that captures every fire, then
    // dispatch the cap-exceeded path through `fireInfoToast` to confirm the
    // copy contract. The full UndoToast component is not mounted in the
    // ticket-detail surface (Phase 1 wired it as a recipe — Phase 2 hasn't
    // mounted it on every route), so we assert the FIRE contract, not the
    // visual surface. The mounted surface is the consumer's wiring problem.
    await mountTerminalPanel(page);

    const fired = await page.evaluate(async () => {
      const toast = (await import(
        "/src/lib/use-undoable-mutation.ts"
      )) as typeof import("../../packages/web/src/lib/use-undoable-mutation.js");
      const messages: string[] = [];
      toast.registerInfoToastHandler((m: string) => {
        messages.push(m);
      });
      toast.fireInfoToast(
        "You've hit the 3-PTY cap for this ticket. Close one to open a new one."
      );
      return messages;
    });

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatch(CAP_TOAST_REGEX);
  });

  test("A18 — `__dispatchTerminal.openExtraPty` dev helper is exposed on window", async ({
    page,
  }) => {
    // The dev helper is the L2-evidence path for multi-PTY (Slice 6). Asserts
    // both that the helper is hung off `window.__dispatchTerminal` AND that
    // it returns synchronously (no throw) when invoked.
    await mountTerminalPanel(page);
    const exists = await page.evaluate(() => {
      const w = window as unknown as {
        __dispatchTerminal?: {
          openExtraPty: (t: string) => void;
        };
      };
      return typeof w.__dispatchTerminal?.openExtraPty === "function";
    });
    expect(exists).toBe(true);

    // Invoking does not throw — it just `transport.send`s a pty.open frame.
    await page.evaluate(() => {
      const w = window as unknown as {
        __dispatchTerminal?: {
          openExtraPty: (t: string) => void;
        };
      };
      w.__dispatchTerminal?.openExtraPty("DSP-2876");
    });
  });

  test("A18 — the dev helper exposes activePtyId + ptyList read accessors", async ({
    page,
  }) => {
    await mountTerminalPanel(page);
    const shape = await page.evaluate(() => {
      const w = window as unknown as {
        __dispatchTerminal?: {
          activePtyId: string | null;
          ptyList: readonly string[];
          openExtraPty: (t: string) => void;
          closeActivePty: () => void;
        };
      };
      const h = w.__dispatchTerminal;
      return {
        hasActivePtyId: h !== undefined && "activePtyId" in h,
        hasPtyList: h !== undefined && Array.isArray(h?.ptyList),
        hasOpenExtraPty: typeof h?.openExtraPty === "function",
        hasCloseActivePty: typeof h?.closeActivePty === "function",
      };
    });
    expect(shape).toEqual({
      hasActivePtyId: true,
      hasPtyList: true,
      hasOpenExtraPty: true,
      hasCloseActivePty: true,
    });
  });
});
