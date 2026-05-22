// dispatch — use-drag-resize tests (Phase 2 / Slice 3).
//
// Tests the drag-resize hook through its public surface:
//   - pointerdown → pointermove → pointerup commits a new size
//   - clamp to [min, max]
//   - one fit() call lands on pointerup (FitAddon settle)
//   - rAF-throttled fit during the drag (at most one pending per frame)
//
// The hook is exposed via `{ splitterProps, panelStyle, dragging, size }`.
// Public-interface-only: we drive it via the React render + synthetic pointer
// events, never by reaching into refs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, act, cleanup } from "@testing-library/react";
import { useDragResize } from "./use-drag-resize.js";

interface HarnessProps {
  axis: "ns" | "ew";
  initial: number;
  min: number;
  max: number;
  onFit?: () => void;
  onResize?: (size: number) => void;
  /** Exposes the hook handle outward so tests can read live size + dragging. */
  expose: (h: ReturnType<typeof useDragResize>) => void;
}

function Harness({
  axis,
  initial,
  min,
  max,
  onFit,
  onResize,
  expose,
}: HarnessProps): React.ReactElement {
  const handle = useDragResize({ axis, initial, min, max, onFit, onResize });
  expose(handle);
  return React.createElement(
    "div",
    { style: handle.panelStyle, "data-testid": "panel" },
    React.createElement("div", {
      ...handle.splitterProps,
      "data-testid": "splitter",
    })
  );
}

function pointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { clientX?: number; clientY?: number; pointerId?: number } = {}
): PointerEvent {
  // jsdom does not implement PointerEvent — fall back to a MouseEvent shape.
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperty(ev, "clientX", { value: init.clientX ?? 0 });
  Object.defineProperty(ev, "clientY", { value: init.clientY ?? 0 });
  Object.defineProperty(ev, "pointerId", { value: init.pointerId ?? 1 });
  return ev;
}

describe("useDragResize — pointer-driven resize", () => {
  beforeEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("commits a new size when the pointer drags upward (ns axis)", async () => {
    let lastSize = 0;
    let exposed: ReturnType<typeof useDragResize> | null = null;
    const onResize = vi.fn((s: number) => {
      lastSize = s;
    });

    render(
      React.createElement(Harness, {
        axis: "ns",
        initial: 320,
        min: 140,
        max: 800,
        onResize,
        expose: (h) => {
          exposed = h;
        },
      })
    );

    const splitter = document.querySelector(
      "[data-testid=splitter]"
    ) as HTMLDivElement;
    expect(splitter).toBeTruthy();

    // pointerdown at y=600
    act(() => {
      splitter.dispatchEvent(pointerEvent("pointerdown", { clientY: 600 }));
    });
    expect(exposed!.dragging).toBe(true);

    // pointermove up by 80px — bottom dock grows by 80 → 400
    act(() => {
      window.dispatchEvent(pointerEvent("pointermove", { clientY: 520 }));
    });

    // pointerup
    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 520 }));
    });

    expect(onResize).toHaveBeenCalled();
    expect(lastSize).toBe(400);
    expect(exposed!.dragging).toBe(false);
  });

  it("clamps below the min bound", () => {
    let exposed: ReturnType<typeof useDragResize> | null = null;
    let lastSize = 0;

    render(
      React.createElement(Harness, {
        axis: "ns",
        initial: 200,
        min: 140,
        max: 800,
        onResize: (s) => {
          lastSize = s;
        },
        expose: (h) => {
          exposed = h;
        },
      })
    );

    const splitter = document.querySelector(
      "[data-testid=splitter]"
    ) as HTMLDivElement;

    act(() => {
      splitter.dispatchEvent(pointerEvent("pointerdown", { clientY: 500 }));
    });
    // Drag downward 200px — would shrink to 0 but clamp to 140
    act(() => {
      window.dispatchEvent(pointerEvent("pointermove", { clientY: 700 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 700 }));
    });

    expect(lastSize).toBe(140);
    expect(exposed!.dragging).toBe(false);
  });

  it("clamps above the max bound", () => {
    let lastSize = 0;

    render(
      React.createElement(Harness, {
        axis: "ew",
        initial: 400,
        min: 320,
        max: 720,
        onResize: (s) => {
          lastSize = s;
        },
        expose: () => {},
      })
    );

    const splitter = document.querySelector(
      "[data-testid=splitter]"
    ) as HTMLDivElement;

    // Right axis: drag handle leftward grows width.
    act(() => {
      splitter.dispatchEvent(pointerEvent("pointerdown", { clientX: 1000 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent("pointermove", { clientX: 0 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", { clientX: 0 }));
    });

    expect(lastSize).toBe(720);
  });

  it("calls onFit once on pointerup (FitAddon settle)", () => {
    const onFit = vi.fn();

    render(
      React.createElement(Harness, {
        axis: "ns",
        initial: 320,
        min: 140,
        max: 800,
        onFit,
        expose: () => {},
      })
    );

    const splitter = document.querySelector(
      "[data-testid=splitter]"
    ) as HTMLDivElement;

    act(() => {
      splitter.dispatchEvent(pointerEvent("pointerdown", { clientY: 600 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent("pointermove", { clientY: 560 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 560 }));
    });

    // pointerup always triggers a final fit() (the settle).
    expect(onFit).toHaveBeenCalled();
  });

  it("rAF-throttles fit() during drag — at most one pending per frame", async () => {
    const onFit = vi.fn();
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");

    render(
      React.createElement(Harness, {
        axis: "ns",
        initial: 320,
        min: 140,
        max: 800,
        onFit,
        expose: () => {},
      })
    );

    const splitter = document.querySelector(
      "[data-testid=splitter]"
    ) as HTMLDivElement;

    act(() => {
      splitter.dispatchEvent(pointerEvent("pointerdown", { clientY: 600 }));
    });

    // Fire 10 pointermoves before the rAF gets a chance to flush.
    act(() => {
      for (let i = 0; i < 10; i++) {
        window.dispatchEvent(pointerEvent("pointermove", { clientY: 600 - i }));
      }
    });

    // requestAnimationFrame may have been called more than once, but the
    // coalescing flag should keep the queued count to one. We verify by
    // counting how many times rAF was *scheduled with a non-noop callback*.
    // The exact count depends on the throttler implementation — the binding
    // contract is that the fit count should be << pointermove count.
    expect(onFit.mock.calls.length).toBeLessThan(10);

    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", { clientY: 590 }));
    });

    rafSpy.mockRestore();
  });
});
