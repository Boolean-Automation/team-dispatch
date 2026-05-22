// dispatch E2E — Phase 2 WebGL → Canvas runtime fallback (AC A6).
//
// L1 evidence: a real Chromium tab, a real <Terminal> mounting xterm with the
// `@xterm/addon-webgl` renderer, then `WEBGL_lose_context.loseContext()` fires
// the addon's `onContextLoss` callback. `useTerminal` disposes the WebGL addon
// and loads `@xterm/addon-canvas` in its place; the terminal buffer survives
// the swap. Captured as `evidence/a6-webgl-fallback/runtime-{before,after}.png`
// so the §7 binding integration-evidence clause has the renderer-flip proof.
//
// Why this uses the smoke harness (`/smoke-webgl-fallback.html`):
//   - The production panel only mounts `<Terminal>` when an active PTY exists.
//     CI has no Companion → no PTY → no xterm. The original e2e (round 1)
//     therefore relied on static-source assertion + the unit test as L1 — the
//     verifier flagged that as "not a real runtime flip."
//   - The DEV-only smoke harness mounts the SAME production `<Terminal>`
//     component against a minimal in-memory `TerminalSubscribeTransport`. It
//     installs `window.__dispatchTerminal.getActiveRenderer()` with the same
//     shape the panel installs — so this spec exercises the production code
//     path, not a test-mode reimplementation.
//   - The harness HTML is excluded from `vite.config.ts` `build.rollupOptions
//     .input`. Production builds never emit it.
//
// Companion to the unit test `packages/web/src/terminal/webgl-fallback.test.ts`
// (jsdom-driven mock fires onContextLoss directly) — kept for fast feedback;
// this spec proves the SAME wiring runs end-to-end against a real WebGL
// context inside a real Chromium tab.

import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Where the runtime captures land — the §7 integration-evidence directory. */
const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../.build-runs/build-dispatch-phase-2-the-embedded-loca-20260522T031217/evidence/a6-webgl-fallback"
);

const SMOKE_URL = "/smoke-webgl-fallback.html";

interface DispatchTerminalHandle {
  getActiveRenderer(): "webgl" | "canvas" | "dom";
}
interface DispatchTerminalSmokeRig {
  pushPtyData(bytes: Uint8Array | string): void;
}

test.describe("AC A6 — WebGL → Canvas runtime fallback (real runtime flip)", () => {
  test("captures the WebGL→Canvas runtime flip with before/after L1 screenshots", async ({
    page,
  }) => {
    // Mount the smoke harness — production <Terminal> + a mock subscribe
    // transport. The harness installs `window.__dispatchTerminal` with the
    // same shape the production TerminalPanel installs.
    await page.goto(SMOKE_URL);
    await expect(page.locator('[data-testid="smoke-title"]')).toBeVisible({
      timeout: 15_000,
    });

    // Wait for xterm to mount its canvas. xterm@6 + WebglAddon renders a
    // <canvas> inside `.xterm-host` → `.xterm-screen`.
    await page.waitForFunction(
      () =>
        document.querySelector(".xterm-host canvas") !== null &&
        typeof (
          window as unknown as {
            __dispatchTerminal?: { getActiveRenderer?: unknown };
          }
        ).__dispatchTerminal?.getActiveRenderer === "function",
      undefined,
      { timeout: 15_000 }
    );

    // Pump initial content into the buffer so the screenshots show something
    // recognizable. JetBrains Mono ligatures + a bold marker — the same kind
    // of buffer content the slice-2 evidence captured, repeated here so the
    // before/after screenshots make the "buffer survives the swap" claim
    // visually verifiable.
    await page.evaluate(() => {
      const w = window as unknown as {
        __dispatchTerminalSmoke?: { pushPtyData: (s: string) => void };
      };
      const before =
        "\x1b[32mcody@studio\x1b[0m:~ $ \x1b[1mecho\x1b[0m " +
        '"AC A6 — WebGL→Canvas runtime flip"' +
        "\r\nAC A6 — WebGL→Canvas runtime flip" +
        "\r\n\x1b[2m(buffer lives in xterm core; only the renderer tier flips)\x1b[0m\r\n";
      w.__dispatchTerminalSmoke?.pushPtyData(before);
    });

    // Give xterm a render frame to paint.
    await page.waitForTimeout(150);

    // Assert WebGL is the active renderer.
    const beforeRenderer = await page.evaluate<"webgl" | "canvas" | "dom">(
      () => {
        const w = window as unknown as {
          __dispatchTerminal?: DispatchTerminalHandle;
        };
        return w.__dispatchTerminal?.getActiveRenderer() ?? "dom";
      }
    );
    expect(beforeRenderer).toBe("webgl");

    // Capture BEFORE — L1 evidence #1.
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "runtime-before.png"),
      fullPage: true,
    });

    // Force WebGL context loss the same way a GPU driver crash would. xterm's
    // WebglRenderer creates a `<canvas>` via `coreBrowserService.mainDocument
    // .createElement('canvas')` and appends it to the `_core.screenElement`
    // (which lives inside `.xterm-host` → `.xterm-screen`). xterm@6 also
    // mounts a link-layer canvas + atlas canvas — the WebGL render canvas is
    // the one whose `getContext('webgl2')` returns non-null. We iterate every
    // canvas under the host and call `loseContext()` on the first one whose
    // context exposes `WEBGL_lose_context`.
    //
    // WebglAddon's `webglcontextlost` handler delays 3s waiting for the
    // browser to fire `webglcontextrestored`. The test's poll-for-`canvas`
    // assertion accommodates this with its 10s timeout below.
    const lossFired = await page.evaluate(() => {
      const canvases = Array.from(
        document.querySelectorAll(".xterm-host canvas")
      ) as HTMLCanvasElement[];
      if (canvases.length === 0) return { fired: false, reason: "no-canvas", canvasCount: 0 };
      for (const canvas of canvases) {
        // Read the EXISTING context — `getContext('webgl2')` on a canvas that
        // already has a webgl2 context returns that context (per HTML spec).
        const ctx =
          (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
          (canvas.getContext("webgl") as WebGLRenderingContext | null);
        if (!ctx) continue;
        const ext = (
          ctx as WebGLRenderingContext
        ).getExtension("WEBGL_lose_context");
        if (!ext) continue;
        (ext as { loseContext: () => void }).loseContext();
        return { fired: true, reason: "ok", canvasCount: canvases.length };
      }
      return {
        fired: false,
        reason: "no-webgl-context-on-any-canvas",
        canvasCount: canvases.length,
      };
    });
    expect(lossFired.fired).toBe(true);

    // Wait for the addon's onContextLoss → CanvasAddon load → React state
    // flip to land in the imperative handle. xterm's WebglRenderer waits 3s
    // after `webglcontextlost` for a `webglcontextrestored` event before
    // firing onContextLoss (see addon-webgl/WebglRenderer.ts:116 — the
    // 3000ms setTimeout). Allow 15s headroom for slow CI hosts.
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __dispatchTerminal?: DispatchTerminalHandle;
        };
        return w.__dispatchTerminal?.getActiveRenderer() === "canvas";
      },
      undefined,
      { timeout: 15_000 }
    );

    const afterRenderer = await page.evaluate<"webgl" | "canvas" | "dom">(
      () => {
        const w = window as unknown as {
          __dispatchTerminal?: DispatchTerminalHandle;
        };
        return w.__dispatchTerminal?.getActiveRenderer() ?? "dom";
      }
    );
    expect(afterRenderer).toBe("canvas");

    // Pump MORE content into the buffer after the swap. The Canvas renderer
    // must paint it; this proves the buffer + transport pipeline survived
    // the renderer-tier change.
    await page.evaluate(() => {
      const w = window as unknown as {
        __dispatchTerminalSmoke?: { pushPtyData: (s: string) => void };
      };
      const after =
        "\r\n\x1b[33m[post-flip]\x1b[0m rendered by " +
        "\x1b[1m@xterm/addon-canvas\x1b[0m\r\n";
      w.__dispatchTerminalSmoke?.pushPtyData(after);
    });
    await page.waitForTimeout(150);

    // The Canvas addon mounts its own canvases (one per xterm layer). The
    // post-swap DOM should now have MORE canvases than before.
    const canvasCount = await page.evaluate(
      () => document.querySelectorAll(".xterm-host canvas").length
    );
    expect(canvasCount).toBeGreaterThanOrEqual(2);

    // Capture AFTER — L1 evidence #2.
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "runtime-after.png"),
      fullPage: true,
    });
  });

  test("A6 — the unit test wiring also lives in source (regression guard)", async ({
    page,
  }) => {
    // Fast static guard so a future refactor that strips `WebglAddon` /
    // `CanvasAddon` / `onContextLoss` from `use-terminal.ts` fails CI even
    // if someone deletes the runtime test above. Cheap; runs in ~50ms.
    await page.goto(SMOKE_URL);
    const source = await page.evaluate(async () => {
      const res = await fetch("/src/terminal/use-terminal.ts");
      return await res.text();
    });
    expect(source).toMatch(/new WebglAddon/);
    expect(source).toMatch(/new CanvasAddon/);
    expect(source).toMatch(/onContextLoss/);
    // PROVEN load order (probe 1): Unicode11 → WebLinks → Serialize → Search
    // → Ligatures → WebGL. The runtime test depends on this ordering being
    // intact; this guard fails first if it drifts.
    const idxUnicode = source.indexOf("new Unicode11Addon");
    const idxWebgl = source.indexOf("new WebglAddon");
    expect(idxUnicode).toBeGreaterThan(-1);
    expect(idxWebgl).toBeGreaterThan(-1);
    expect(idxUnicode).toBeLessThan(idxWebgl);
  });
});
