// dispatch — useTerminalSettings RACE test (Phase 2 / Slice 5).
//
// Codex F6 binding. The interleaved-read-then-write race the slice plan calls
// out (§S5 / "Two-tab e2e test"):
//
//   Tab A: changes `position` (bottom → right).
//   50ms later, Tab B: changes `font.size` (13 → 14).
//
// Both writes must land — meaning the FINAL Clerk publicMetadata contains
// BOTH `position === 'right'` AND `font.size === 14`.
//
// The implementation passes this test because each tab:
//   1. Reads fresh metadata immediately before writing.
//   2. Per-field merges its change.
//   3. Writes back, then verifies the read-back matches; retries once on
//      conflict.
//
// A naive whole-object-replace write would CLOBBER the other tab's change
// (this is the failure mode that fails this test).
//
// The Clerk simulation here is intentionally synchronous: user.update is
// atomic from the caller's POV; reload returns the latest committed state.
// That's what Clerk's API actually offers. The race we're proving safety
// against is interleaved CLIENT-side reads + writes, not Clerk-side races.

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useTerminalSettings,
  type ClerkLikeUser,
  type SettingsBroadcaster,
} from "./use-terminal-settings.js";

/**
 * A shared "Clerk backend" that all tabs read from + write to. user.reload
 * pulls the latest state into the per-tab snapshot; user.update is atomic
 * (last-write-wins per call, but each call sees fresh state because the tabs
 * reload before merging).
 */
function makeSharedClerkBackend(): {
  read(): Record<string, unknown>;
  write(next: Record<string, unknown>): void;
} {
  let pm: Record<string, unknown> = {};
  return {
    read: () => ({ ...pm }),
    write: (next) => {
      pm = { ...next };
    },
  };
}

/** A per-tab Clerk-like user that talks to the shared backend. */
function makeTab(
  backend: ReturnType<typeof makeSharedClerkBackend>,
  userId = "user_race_1"
): ClerkLikeUser {
  let snapshot: Record<string, unknown> = backend.read();
  return {
    id: userId,
    get publicMetadata() {
      return snapshot;
    },
    async reload() {
      snapshot = backend.read();
    },
    async update(patch) {
      backend.write(patch.publicMetadata);
      snapshot = backend.read();
    },
  };
}

const inertBroadcaster = (_name: string): SettingsBroadcaster => ({
  postMessage() {
    /* no cross-tab in this test — we test the Clerk RMW path, not BC */
  },
  close() {
    /* no-op */
  },
});

describe("useTerminalSettings — two-tab race (Codex F6 binding)", () => {
  it("preserves BOTH tabs' changes when writes interleave (position + font.size)", async () => {
    const backend = makeSharedClerkBackend();
    // Seed the backend so both tabs start with defaults already on disk —
    // matches the production state where the SE has saved settings before.
    backend.write({
      terminalSettings: {
        _v: 1,
        position: "bottom",
        theme: "coal",
        font: { family: "JetBrains Mono", size: 13 },
        scrollbackLines: 10000,
        launcher: { label: "Claude", command: "claude" },
        launcherConsentedAt: null,
      },
    });

    const tabA = makeTab(backend, "user_race_1");
    const tabB = makeTab(backend, "user_race_1");

    const hookA = renderHook(() =>
      useTerminalSettings({
        user: tabA,
        debounceMs: 0,
        createBroadcaster: inertBroadcaster,
      })
    );
    const hookB = renderHook(() =>
      useTerminalSettings({
        user: tabB,
        debounceMs: 0,
        createBroadcaster: inertBroadcaster,
      })
    );

    // Tab A fires; 50ms later tab B fires. Both run through the same
    // shared backend.
    await act(async () => {
      const pA = hookA.result.current.save({ position: "right" });
      // simulate the 50ms gap from the plan
      await new Promise((r) => setTimeout(r, 50));
      const pB = hookB.result.current.save({ font: { size: 14 } as never });
      await Promise.all([pA, pB]);
    });

    // The shared backend should contain BOTH changes.
    const final = backend.read()["terminalSettings"] as {
      position: string;
      font: { size: number };
      theme: string;
      scrollbackLines: number;
      _v: number;
    };
    expect(final._v).toBe(1);
    expect(final.position).toBe("right");
    expect(final.font.size).toBe(14);
    // The unrelated fields stayed put.
    expect(final.theme).toBe("coal");
    expect(final.scrollbackLines).toBe(10000);

    hookA.unmount();
    hookB.unmount();
  });

  it("retry-once salvages B when its first write loses a server-side conflict", async () => {
    // This proves the retry-once mechanism: if B's read-back shows the merged
    // value did NOT land (because A clobbered it server-side BETWEEN B's
    // update and B's read-back), B re-reads + re-merges + re-writes.
    //
    // Setup: B's first update is intercepted — A writes immediately after,
    // so B's read-back shows A's position, not B's merged position. B detects
    // the mismatch and retries. The retry succeeds.
    const backend = makeSharedClerkBackend();
    backend.write({
      terminalSettings: {
        _v: 1,
        position: "bottom",
        theme: "coal",
        font: { family: "JetBrains Mono", size: 13 },
        scrollbackLines: 10000,
        launcher: { label: "Claude", command: "claude" },
        launcherConsentedAt: null,
      },
    });

    const tabA = makeTab(backend, "user_race_3");
    const tabB = makeTab(backend, "user_race_3");

    // Sequence: B reads. B is about to write. INJECT: A also wants to set
    // position=right. Intercept B's update so A's write lands AFTER B's,
    // making B's read-back show A's value (not B's merged value).
    let bUpdateCount = 0;
    const origUpdateB = tabB.update.bind(tabB);
    tabB.update = async (patch) => {
      bUpdateCount++;
      await origUpdateB(patch);
      if (bUpdateCount === 1) {
        // After B's first update lands, A swoops in with its own write.
        // B's merged sets position to whatever it merged (stale was 'bottom'),
        // and A overwrites with position='right'. The next read-back will
        // show A's position, mismatching B's merged value → retry.
        await tabA.update({
          publicMetadata: {
            terminalSettings: {
              _v: 1,
              position: "right",
              theme: "coal",
              font: { family: "JetBrains Mono", size: 13 },
              scrollbackLines: 10000,
              launcher: { label: "Claude", command: "claude" },
              launcherConsentedAt: null,
            },
          },
        });
      }
    };

    const hookB = renderHook(() =>
      useTerminalSettings({
        user: tabB,
        debounceMs: 0,
        createBroadcaster: inertBroadcaster,
      })
    );

    await act(async () => {
      await hookB.result.current.save({ scrollbackLines: 5000 });
    });

    // After retry-once: B's second attempt sees A's position (right), merges
    // with its own scrollback change, both survive.
    const final = backend.read()["terminalSettings"] as {
      position: string;
      scrollbackLines: number;
    };
    expect(final.position).toBe("right");
    expect(final.scrollbackLines).toBe(5000);
    // B's update was called twice (initial + retry).
    expect(bUpdateCount).toBe(2);

    hookB.unmount();
  });

  it("preserves BOTH tabs' changes when writes are simultaneous (no gap)", async () => {
    const backend = makeSharedClerkBackend();
    backend.write({
      terminalSettings: {
        _v: 1,
        position: "bottom",
        theme: "coal",
        font: { family: "JetBrains Mono", size: 13 },
        scrollbackLines: 10000,
        launcher: { label: "Claude", command: "claude" },
        launcherConsentedAt: null,
      },
    });

    const tabA = makeTab(backend, "user_race_2");
    const tabB = makeTab(backend, "user_race_2");

    const hookA = renderHook(() =>
      useTerminalSettings({
        user: tabA,
        debounceMs: 0,
        createBroadcaster: inertBroadcaster,
      })
    );
    const hookB = renderHook(() =>
      useTerminalSettings({
        user: tabB,
        debounceMs: 0,
        createBroadcaster: inertBroadcaster,
      })
    );

    // Fire both saves concurrently — no gap.
    await act(async () => {
      const pA = hookA.result.current.save({ theme: "paper" });
      const pB = hookB.result.current.save({ scrollbackLines: 5000 });
      await Promise.all([pA, pB]);
    });

    const final = backend.read()["terminalSettings"] as {
      theme: string;
      scrollbackLines: number;
    };
    expect(final.theme).toBe("paper");
    expect(final.scrollbackLines).toBe(5000);

    hookA.unmount();
    hookB.unmount();
  });
});
