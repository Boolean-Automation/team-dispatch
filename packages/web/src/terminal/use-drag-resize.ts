// dispatch — use-drag-resize (Phase 2 / Slice 3).
//
// Continuous drag-resize for the bottom-dock + dock-right panel splitters,
// per visual-spec §8 and plan §S3. The pattern is:
//   1. pointerdown on the splitter → setPointerCapture, mark .is-dragging.
//   2. pointermove → compute new size from delta, clamp to [min, max].
//      Write to the live `panelStyle.transform` AND schedule a rAF-coalesced
//      `onFit()` call (the FitAddon reflow + pty.resize). 0.55 fits/pointermove
//      is the prototype-proven bench (probe 4).
//   3. pointerup → releasePointerCapture, drop .is-dragging, commit `size`
//      via `onResize`, and call `onFit()` one last time as the settle.
//
// The hook does NOT own the FitAddon — the caller supplies an `onFit` thunk.
// The hook does NOT own pty.resize — the caller's onFit hook is expected to
// dispatch that frame after fit().
//
// Public-interface-only test surface:
//   - `splitterProps` — spread onto the splitter element to bind events.
//   - `panelStyle`    — spread onto the panel host for the transform during drag.
//   - `size`          — the committed size (only changes on pointerup).
//   - `dragging`      — whether a drag is in flight (UI .is-dragging class).

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseDragResizeOptions {
  /** `ns` = bottom dock (drag vertically); `ew` = right dock (drag horizontally). */
  axis: "ns" | "ew";
  /** Starting size in px. */
  initial: number;
  /** Min size (bounds clamp). */
  min: number;
  /** Max size (bounds clamp). */
  max: number;
  /** rAF-coalesced fit hook — called during drag (throttled) AND on pointerup. */
  onFit?: () => void;
  /** Commit hook — called on pointerup with the final size. */
  onResize?: (size: number) => void;
}

export interface UseDragResizeResult {
  /** Props to spread onto the splitter element. */
  splitterProps: {
    onPointerDown: (ev: React.PointerEvent<HTMLDivElement>) => void;
    className: string;
  };
  /** Style to spread onto the panel host — keeps the panel size in sync. */
  panelStyle: React.CSSProperties;
  /** The current (committed) size. Only updates on pointerup. */
  size: number;
  /** Whether a drag is currently active. */
  dragging: boolean;
}

/**
 * useDragResize — pointer-driven, rAF-throttled drag-resize hook.
 *
 * Honors visual-spec §8 (state machine) and the prototype-proven 0.55
 * fits/pointermove bench (probe 4).
 */
export function useDragResize(
  opts: UseDragResizeOptions
): UseDragResizeResult {
  const { axis, initial, min, max, onFit, onResize } = opts;
  const [size, setSize] = useState(initial);
  const [dragging, setDragging] = useState(false);

  // Live drag state held in refs — pointer event handlers see fresh values
  // without re-binding listeners.
  const startCoord = useRef(0);
  const startSize = useRef(initial);
  const liveSize = useRef(initial);
  const rafScheduled = useRef(false);
  const pointerCaptureEl = useRef<HTMLElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  // Latest callbacks in refs so handlers see fresh fns without re-binding.
  const onFitRef = useRef(onFit);
  const onResizeRef = useRef(onResize);
  onFitRef.current = onFit;
  onResizeRef.current = onResize;

  const handlePointerMove = useCallback(
    (ev: PointerEvent) => {
      // Only honor the captured pointer.
      if (
        pointerIdRef.current !== null &&
        ev.pointerId !== pointerIdRef.current
      ) {
        return;
      }
      const coord = axis === "ns" ? ev.clientY : ev.clientX;
      const delta = startCoord.current - coord;
      const next = Math.max(min, Math.min(max, startSize.current + delta));
      liveSize.current = next;

      // rAF-coalesce the onFit call.
      if (!rafScheduled.current) {
        rafScheduled.current = true;
        requestAnimationFrame(() => {
          rafScheduled.current = false;
          try {
            onFitRef.current?.();
          } catch {
            /* host detached mid-drag */
          }
        });
      }
    },
    [axis, min, max]
  );

  const handlePointerUp = useCallback(
    (_ev: PointerEvent) => {
      if (pointerCaptureEl.current && pointerIdRef.current !== null) {
        try {
          pointerCaptureEl.current.releasePointerCapture(pointerIdRef.current);
        } catch {
          /* never captured */
        }
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);

      const committed = liveSize.current;
      setSize(committed);
      setDragging(false);
      pointerCaptureEl.current = null;
      pointerIdRef.current = null;
      try {
        onResizeRef.current?.(committed);
      } catch {
        /* host detached */
      }
      // Final settle fit().
      try {
        onFitRef.current?.();
      } catch {
        /* host detached */
      }
    },
    [handlePointerMove]
  );

  const onPointerDown = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      ev.preventDefault();
      const target = ev.currentTarget;
      startCoord.current = axis === "ns" ? ev.clientY : ev.clientX;
      startSize.current = size;
      liveSize.current = size;
      pointerCaptureEl.current = target;
      pointerIdRef.current = ev.pointerId;
      try {
        target.setPointerCapture(ev.pointerId);
      } catch {
        /* not supported in jsdom */
      }
      setDragging(true);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [axis, size, handlePointerMove, handlePointerUp]
  );

  // Cleanup on unmount — never leak pointer listeners.
  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  const panelStyle: React.CSSProperties =
    axis === "ns" ? { height: `${size}px` } : { width: `${size}px` };

  return {
    splitterProps: {
      onPointerDown,
      className: `term-splitter${axis === "ew" ? " vert" : ""}${
        dragging ? " is-dragging" : ""
      }`,
    },
    panelStyle,
    size,
    dragging,
  };
}
