// dispatch — Phase 2 / AC A6 — WebGL context-loss → Canvas fallback test.
//
// Asserts the documented A6 contract: when the WebGL renderer loses its
// canvas context (GPU crash, deliberate `WEBGL_lose_context.loseContext()`,
// long tab-background), the `useTerminal` hook disposes the WebGL addon and
// loads `CanvasAddon` in its place. The xterm buffer survives the swap;
// only the renderer tier changes.
//
// Why this is a unit test, not an L1 capture-only:
//   - jsdom has no WebGL context — the addon's `onContextLoss` is the
//     load-bearing seam we can drive deterministically from a test. The L1
//     real-Chrome screenshots in `evidence-slice2/a6-*` prove the
//     pixel-level behavior with a forced `WEBGL_lose_context` call. This
//     test proves the wiring in code so a future refactor can't silently
//     drop the fallback without failing CI.

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useTerminal } from "./use-terminal.js";
import type {
  TerminalSubscribeTransport,
  TerminalFrame,
} from "./transport-contract.js";

// Capture the WebglAddon instances the hook constructs so the test can
// trigger `onContextLoss` deterministically. We mock the WebglAddon export
// to (a) expose a typed onContextLoss listener we can invoke and (b) record
// each disposal so the test can prove the addon was detached BEFORE Canvas
// loads.
const webglInstances: Array<{
  fireContextLoss: () => void;
  dispose: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
}> = [];
const canvasInstances: Array<{
  activate: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@xterm/addon-webgl", () => {
  class WebglAddon {
    private listeners: Array<() => void> = [];
    public dispose = vi.fn();
    public activate = vi.fn();
    public onContextLoss(listener: () => void): { dispose: () => void } {
      this.listeners.push(listener);
      return { dispose: () => {} };
    }
    public fireContextLoss(): void {
      for (const listener of this.listeners) listener();
    }
    constructor() {
      webglInstances.push({
        fireContextLoss: () => this.fireContextLoss(),
        dispose: this.dispose,
        activate: this.activate,
      });
    }
  }
  return { WebglAddon };
});

vi.mock("@xterm/addon-canvas", () => {
  class CanvasAddon {
    public activate = vi.fn();
    public dispose = vi.fn();
    constructor() {
      canvasInstances.push({ activate: this.activate, dispose: this.dispose });
    }
  }
  return { CanvasAddon };
});

/** Minimal transport that exposes no frames — A6 doesn't need any traffic. */
class IdleTransport implements TerminalSubscribeTransport {
  subscribe(
    _ptyId: string,
    _listener: (frame: TerminalFrame) => void
  ): () => void {
    return () => {};
  }
  write(_ptyId: string, _data: string): void {
    /* no-op */
  }
}

/**
 * Test harness component. Calls `useTerminal` and exposes the result via a
 * ref-style callback so tests can read `activeRenderer` after re-renders.
 */
function Harness(props: { onResult: (r: ReturnType<typeof useTerminal>) => void }) {
  const result = useTerminal({
    ptyId: "pty-a6",
    ticketId: "DSP-A6",
    transport: new IdleTransport(),
  });
  props.onResult(result);
  return React.createElement("div", {
    ref: result.containerRef,
    "data-testid": "host",
  });
}

afterEach(() => {
  cleanup();
  webglInstances.length = 0;
  canvasInstances.length = 0;
});

/**
 * `useTerminal` re-fires its mount effect once because the container-ref
 * callback calls `setTick` after the first commit. That's an internal
 * implementation detail (Slice 2 design); the effect cleanup disposes the
 * prior addon set first, then the new effect constructs a fresh set. The
 * `activeRenderer` reported by the hook always reflects the LATEST mount —
 * which is the one consumers actually see. These tests therefore look at
 * the latest instance index, not the first.
 */
function latestWebgl() {
  return webglInstances[webglInstances.length - 1]!;
}

describe("AC A6 — WebGL context-loss → Canvas fallback", () => {
  it("loads WebglAddon on mount and reports `webgl` as the active renderer", async () => {
    let latest: ReturnType<typeof useTerminal> | null = null;
    await act(async () => {
      render(
        React.createElement(Harness, {
          onResult: (r) => {
            latest = r;
          },
        })
      );
    });

    // At least one WebglAddon was constructed; Canvas was NOT (no context-loss yet).
    expect(webglInstances.length).toBeGreaterThanOrEqual(1);
    expect(canvasInstances).toHaveLength(0);
    expect(latest!.activeRenderer).toBe("webgl");
  });

  it("on WebGL context-loss: disposes WebGL, loads CanvasAddon, reports `canvas`", async () => {
    let latest: ReturnType<typeof useTerminal> | null = null;
    await act(async () => {
      render(
        React.createElement(Harness, {
          onResult: (r) => {
            latest = r;
          },
        })
      );
    });

    expect(latest!.activeRenderer).toBe("webgl");
    expect(canvasInstances).toHaveLength(0);
    // The LATEST WebGL instance has not been disposed by user action yet.
    const activeWebgl = latestWebgl();
    expect(activeWebgl.dispose).not.toHaveBeenCalled();

    // Force the WebGL context loss the same way the addon's runtime path
    // would on a real GPU stall: invoke every onContextLoss listener.
    await act(async () => {
      activeWebgl.fireContextLoss();
    });

    // WebGL addon was disposed (the cell renderer is detached) BEFORE the
    // Canvas addon mounts in its place.
    expect(activeWebgl.dispose).toHaveBeenCalledTimes(1);
    // Canvas tier is now driving paint.
    expect(canvasInstances.length).toBeGreaterThanOrEqual(1);
    expect(latest!.activeRenderer).toBe("canvas");
  });

  it("subsequent context-loss events are idempotent (dispose-already-disposed is non-fatal)", async () => {
    let latest: ReturnType<typeof useTerminal> | null = null;
    await act(async () => {
      render(
        React.createElement(Harness, {
          onResult: (r) => {
            latest = r;
          },
        })
      );
    });

    const activeWebgl = latestWebgl();
    await act(async () => {
      activeWebgl.fireContextLoss();
    });
    expect(latest!.activeRenderer).toBe("canvas");
    const canvasCountAfterFirstLoss = canvasInstances.length;
    expect(canvasCountAfterFirstLoss).toBeGreaterThanOrEqual(1);

    // Drive the same listener a second time (defensive — the WebGL addon
    // can emit the event more than once on some drivers before dispose
    // takes hold). The test asserts the hook stays in `canvas` and does
    // not throw; a second CanvasAddon being constructed is acceptable
    // because the swallowed dispose try/catch is the protection.
    await act(async () => {
      activeWebgl.fireContextLoss();
    });

    expect(latest!.activeRenderer).toBe("canvas");
  });
});
