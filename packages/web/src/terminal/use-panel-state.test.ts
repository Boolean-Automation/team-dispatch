// dispatch — usePanelState tests (Phase 2 / review-fix P2-4).
//
// Created as part of the gate-review.md P2-4 fix. The reducer was previously
// firing the Clerk `persistPosition` side effect from INSIDE the setState
// reducer, which made it call twice under React 18 StrictMode (the dev
// double-render contract). The fix moves the side effect to a useEffect that
// watches `state.position` — these tests verify:
//   1. togglePosition fires persist EXACTLY ONCE per change, even under
//      StrictMode (the binding test).
//   2. setPosition fires persist EXACTLY ONCE per change.
//   3. Setting the same position is a no-op (no spurious persist call).
//   4. Initial mount does NOT fire persist for the default position.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePanelState } from "./use-panel-state.js";

beforeEach(() => {
  // The hook reads localStorage at mount; remove the panel-state key so each
  // test starts clean. (Avoid `localStorage.clear()` — not implemented in
  // some jsdom versions used by this repo.)
  try {
    localStorage.removeItem("dispatch::terminal::panel-state");
  } catch {
    /* environment without localStorage — fine */
  }
});

describe("usePanelState — P2-4 side-effect-out-of-reducer fix", () => {
  it("togglePosition fires persistPosition EXACTLY ONCE under StrictMode", () => {
    // The binding test for P2-4: pre-fix, the persist call inside the
    // reducer fired TWICE in StrictMode (React's purity-check double-invoke).
    // Post-fix, the useEffect-driven persist fires once per actual change.
    const persistPosition = vi.fn();

    const { result } = renderHook(
      () => usePanelState({ initialPosition: "bottom", persistPosition }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) =>
          React.createElement(React.StrictMode, null, children),
      }
    );

    // Initial mount must NOT persist — we only persist user-driven changes.
    expect(persistPosition).not.toHaveBeenCalled();

    // Toggle: bottom → right.
    act(() => {
      result.current.togglePosition();
    });

    // The persistPosition spy MUST have been called exactly once.
    expect(persistPosition).toHaveBeenCalledTimes(1);
    expect(persistPosition).toHaveBeenCalledWith("right");

    // Toggle back: right → bottom — second distinct change.
    act(() => {
      result.current.togglePosition();
    });
    expect(persistPosition).toHaveBeenCalledTimes(2);
    expect(persistPosition).toHaveBeenLastCalledWith("bottom");
  });

  it("setPosition fires persistPosition exactly once per distinct change", () => {
    const persistPosition = vi.fn();
    const { result } = renderHook(
      () => usePanelState({ initialPosition: "bottom", persistPosition }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) =>
          React.createElement(React.StrictMode, null, children),
      }
    );

    act(() => {
      result.current.setPosition("right");
    });
    expect(persistPosition).toHaveBeenCalledTimes(1);
    expect(persistPosition).toHaveBeenCalledWith("right");
  });

  it("setPosition to the SAME value is a no-op (no spurious persist)", () => {
    const persistPosition = vi.fn();
    const { result } = renderHook(
      () => usePanelState({ initialPosition: "bottom", persistPosition }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) =>
          React.createElement(React.StrictMode, null, children),
      }
    );

    act(() => {
      result.current.setPosition("bottom");
    });
    expect(persistPosition).not.toHaveBeenCalled();
  });

  it("persist failures do NOT prevent the position from flipping locally", () => {
    // The reducer must stay pure even when the persist callback throws —
    // the toggle should land in local state regardless of persistence
    // success. This codifies the pre-existing behavior comment that
    // "persistence errors surface via SaveStateChip — don't block toggle."
    const persistPosition = vi.fn(() => {
      throw new Error("clerk down");
    });
    const { result } = renderHook(() =>
      usePanelState({ initialPosition: "bottom", persistPosition })
    );

    act(() => {
      result.current.togglePosition();
    });
    expect(result.current.state.position).toBe("right");
    expect(persistPosition).toHaveBeenCalledTimes(1);
  });

  it("syncedPosition (from Settings) does NOT fire persistPosition (one-way flow)", () => {
    // NEW-1 binding test (round-2 gate-review.md): syncedPosition is the
    // Clerk → local direction. Local state updates, but the persist effect
    // MUST stay silent — otherwise every cross-tab BC sync round-trips
    // through Clerk, doubling writes. Pre-fix this asserted
    // `toHaveBeenCalledTimes(1)`, which codified the bug. Post-fix the
    // syncedPosition useEffect pre-stamps prevPersistedPositionRef so the
    // persist effect's equality guard suppresses the spurious write.
    const persistPosition = vi.fn();
    const { result, rerender } = renderHook(
      ({ synced }: { synced: "bottom" | "right" }) =>
        usePanelState({
          initialPosition: "bottom",
          syncedPosition: synced,
          persistPosition,
        }),
      { initialProps: { synced: "bottom" as "bottom" | "right" } }
    );

    expect(result.current.state.position).toBe("bottom");

    // Settings pushes 'right' in.
    rerender({ synced: "right" });
    expect(result.current.state.position).toBe("right");
    // The sync-driven flip MUST NOT fire persistPosition — that would be a
    // write-loop with the other tab.
    expect(persistPosition).toHaveBeenCalledTimes(0);
  });

  it("NEW-1 regression guard: user-driven togglePosition STILL fires persist even when syncedPosition is wired", () => {
    // The NEW-1 fix pre-stamps prevPersistedPositionRef from syncedPosition
    // updates. This test proves the fix didn't accidentally break the P2-4
    // contract: a USER-DRIVEN togglePosition (toolbar) must still fire the
    // Clerk write exactly once.
    const persistPosition = vi.fn();
    const { result } = renderHook(() =>
      usePanelState({
        initialPosition: "bottom",
        syncedPosition: "bottom",
        persistPosition,
      })
    );

    expect(persistPosition).not.toHaveBeenCalled();

    act(() => {
      result.current.togglePosition();
    });

    expect(result.current.state.position).toBe("right");
    expect(persistPosition).toHaveBeenCalledTimes(1);
    expect(persistPosition).toHaveBeenCalledWith("right");
  });
});
