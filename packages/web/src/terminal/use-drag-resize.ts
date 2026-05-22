// dispatch — use-drag-resize (Phase 2 / Slice 3).
//
// Continuous drag-resize for the bottom-dock + dock-right panel splitters,
// per visual-spec §8 and plan §S3. The pattern is:
//   1. pointerdown on the splitter → setPointerCapture, mark .is-dragging.
//   2. pointermove → compute new size from delta, clamp to [min, max].
//      P2-3 fix (gate-review.md): the LIVE size is stored in React state via
//      `liveSize` (separate from the committed `size`), so the returned
//      `panelStyle` reflects the latest pointer delta DURING the drag. The
//      panel element re-renders per frame and the user sees AC A15
//      ("continuous drag-resize splitter") actually behave continuously. The
//      pre-fix shape only updated `panelStyle` on pointerup, so the visual
//      feedback was end-of-drag, not during-drag.
//      Also schedule a rAF-coalesced `onFit()` call (the FitAddon reflow +
//      pty.resize). 0.55 fits/pointermove is the prototype-proven bench
//      (probe 4) — fit() throttles at rAF, panelStyle updates per move.
//   3. pointerup → releasePointerCapture, drop .is-dragging, commit `size`
//      via `onResize`, and call `onFit()` one last time as the settle.
//
// The hook does NOT own the FitAddon — the caller supplies an `onFit` thunk.
// The hook does NOT own pty.resize — the caller's onFit hook is expected to
// dispatch that frame after fit().
//
// Public-interface-only test surface:
//   - `splitterProps` — spread onto the splitter element to bind events.
//   - `panelStyle`    — spread onto the panel host. Reflects the LIVE drag size
//                       during a drag, then commits on pointerup.
//   - `size`          — the committed size (only changes on pointerup).
//   - `liveSize`      — the live drag size (changes during pointermove).
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
  /**
   * Style to spread onto the panel host. P2-3 fix: this reflects the LIVE
   * drag size during pointermove, not just the committed size — so the panel
   * follows the pointer continuously (AC A15 binding).
   */
  panelStyle: React.CSSProperties;
  /** The current (committed) size. Only updates on pointerup. */
  size: number;
  /**
   * P2-3 fix: the live drag size — updates per pointermove during a drag.
   * Equal to `size` when no drag is in flight. Exposed so tests can assert
   * continuous reflow without poking at refs.
   */
  liveSize: number;
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
  // P2-3 fix (gate-review.md): live drag size lives in React state, not just
  // a ref, so the returned `panelStyle` re-renders the panel host per frame
  // during the drag. AC A15 binding: the user must see the panel reflow
  // continuously as the pointer moves, not jump at pointerup.
  const [liveSize, setLiveSize] = useState(initial);

  // Live drag refs — pointer event handlers see fresh values without
  // re-binding listeners. `liveSizeRef` mirrors the React state so the
  // pointerup commit can read the latest value synchronously.
  const startCoord = useRef(0);
  const startSize = useRef(initial);
  const liveSizeRef = useRef(initial);
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
      liveSizeRef.current = next;
      // P2-3 fix (gate-review.md): push the live size into React state so
      // the returned `panelStyle` re-renders the panel host per move. AC A15
      // requires the panel to reflow continuously — pre-fix, panelStyle only
      // tracked the committed `size` (pointerup), so the panel jumped at
      // end-of-drag rather than following the pointer.
      setLiveSize(next);

      // rAF-coalesce the onFit call. Fit (xterm reflow + pty.resize) stays
      // throttled at 0.55 fits/pointermove (probe 4 bench); the panel
      // dimension itself updates per pointermove via setLiveSize above.
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

      const committed = liveSizeRef.current;
      setSize(committed);
      // P2-3: also commit the live state so panelStyle stays consistent
      // post-drag (no flicker between liveSize and size at the end-of-drag
      // boundary). The setLiveSize call is a no-op when liveSize already
      // equals committed.
      setLiveSize(committed);
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
      liveSizeRef.current = size;
      setLiveSize(size);
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

  // P2-3 fix (gate-review.md): panelStyle reflects the LIVE drag size during
  // a drag (via the React `liveSize` state), so the panel reflows
  // continuously as the pointer moves. When not dragging, `liveSize === size`
  // so panelStyle is the committed size.
  const renderedSize = dragging ? liveSize : size;
  const panelStyle: React.CSSProperties =
    axis === "ns"
      ? { height: `${renderedSize}px` }
      : { width: `${renderedSize}px` };

  return {
    splitterProps: {
      onPointerDown,
      className: `term-splitter${axis === "ew" ? " vert" : ""}${
        dragging ? " is-dragging" : ""
      }`,
    },
    panelStyle,
    size,
    liveSize,
    dragging,
  };
}
