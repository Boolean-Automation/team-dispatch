// dispatch — useTerminalSettings tests (Phase 2 / Slice 5).
//
// Per the slice plan:
//   1. Default settings when publicMetadata absent.
//   2. save() merges per-field (font.size doesn't blow away font.family).
//   3. Size budget throws above 6 KB.
//   4. saveState transitions: idle → saving → saved → idle.
//   5. Retry-once on conflict.
//   6. 'unsaved' after retry exhausted.
//   7. 'unsaved' after 5s in-flight.
//   8. BroadcastChannel emit on successful save.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  useTerminalSettings,
  DEFAULT_TERMINAL_SETTINGS,
  mergeTerminalSettings,
  readTerminalSettings,
  TerminalSettingsBudgetError,
  SIZE_BUDGET_BYTES,
  type ClerkLikeUser,
  type SettingsBroadcaster,
} from "./use-terminal-settings.js";

// ── A fake Clerk user with a write-monitor ──────────────────────────────────
//
// `user.update()` last-write-wins; `user.reload()` is a no-op (the snapshot
// is updated synchronously by `update`). Tests can swap in a fancier model
// for the conflict / race scenarios.

function makeFakeUser(initial?: Record<string, unknown>): ClerkLikeUser & {
  writes: Array<Record<string, unknown>>;
  setFreshOverride: (next: Record<string, unknown>) => void;
} {
  let pm: Record<string, unknown> = { ...(initial ?? {}) };
  let freshOverride: Record<string, unknown> | null = null;
  const writes: Array<Record<string, unknown>> = [];

  const user = {
    id: "user_test_1",
    get publicMetadata(): Record<string, unknown> {
      return pm;
    },
    async reload() {
      if (freshOverride) {
        pm = { ...freshOverride };
        freshOverride = null;
      }
    },
    async update(patch: { publicMetadata: Record<string, unknown> }) {
      pm = { ...patch.publicMetadata };
      writes.push(patch.publicMetadata);
    },
    writes,
    setFreshOverride(next: Record<string, unknown>) {
      freshOverride = next;
    },
  };
  return user;
}

// ── Pure-helper tests (no React) ─────────────────────────────────────────────

describe("readTerminalSettings — defaults when metadata absent / malformed", () => {
  it("returns defaults when metadata is undefined", () => {
    expect(readTerminalSettings(undefined)).toEqual(DEFAULT_TERMINAL_SETTINGS);
  });

  it("returns defaults when terminalSettings is missing", () => {
    expect(readTerminalSettings({ other: 1 })).toEqual(
      DEFAULT_TERMINAL_SETTINGS
    );
  });

  it("falls back to default per-field when individual fields are malformed", () => {
    const result = readTerminalSettings({
      terminalSettings: {
        _v: 1,
        position: "diagonal",
        theme: "neon",
        font: { family: "Comic Sans", size: 99 },
        scrollbackLines: 999_999,
        launcher: { label: "", command: "" },
      },
    });
    // Malformed values fall back to per-field defaults.
    expect(result.position).toBe("bottom");
    expect(result.theme).toBe("coal");
    expect(result.font.family).toBe("Comic Sans"); // family is free-text
    expect(result.font.size).toBe(13);
    expect(result.scrollbackLines).toBe(10000);
    expect(result.launcher).toEqual({ label: "Claude", command: "claude" });
  });

  it("preserves a valid full settings object", () => {
    const full = {
      terminalSettings: {
        _v: 1,
        position: "right",
        theme: "paper",
        font: { family: "JetBrains Mono", size: 14 },
        scrollbackLines: 5000,
        launcher: { label: "Codex", command: "codex" },
        launcherConsentedAt: "2026-05-22T00:00:00Z",
      },
    };
    const result = readTerminalSettings(full);
    expect(result.position).toBe("right");
    expect(result.theme).toBe("paper");
    expect(result.font.size).toBe(14);
    expect(result.scrollbackLines).toBe(5000);
    expect(result.launcher.label).toBe("Codex");
    expect(result.launcherConsentedAt).toBe("2026-05-22T00:00:00Z");
  });
});

describe("mergeTerminalSettings — per-field merge, never whole-object replace", () => {
  it("merges font.size without losing font.family", () => {
    const base = mergeTerminalSettings(DEFAULT_TERMINAL_SETTINGS, {
      font: { size: 14 } as never,
    });
    expect(base.font.family).toBe("JetBrains Mono");
    expect(base.font.size).toBe(14);
  });

  it("merges launcher.command without losing launcher.label", () => {
    const result = mergeTerminalSettings(DEFAULT_TERMINAL_SETTINGS, {
      launcher: { label: "Claude", command: "codex" },
    });
    expect(result.launcher.label).toBe("Claude");
    expect(result.launcher.command).toBe("codex");
  });

  it("changes position when explicitly given", () => {
    const result = mergeTerminalSettings(DEFAULT_TERMINAL_SETTINGS, {
      position: "right",
    });
    expect(result.position).toBe("right");
  });
});

// ── Hook tests ───────────────────────────────────────────────────────────────

describe("useTerminalSettings — saveState machine + retry + budget", () => {
  let broadcasts: unknown[] = [];

  const makeBroadcaster = (_name: string): SettingsBroadcaster => ({
    postMessage(payload: unknown) {
      broadcasts.push(payload);
    },
    close() {
      /* no-op */
    },
  });

  beforeEach(() => {
    broadcasts = [];
  });

  it("returns defaults when user is null", () => {
    const { result } = renderHook(() =>
      useTerminalSettings({ user: null, debounceMs: 0 })
    );
    expect(result.current.settings).toEqual(DEFAULT_TERMINAL_SETTINGS);
    expect(result.current.saveState).toBe("idle");
  });

  it("merges existing metadata when present", () => {
    const user = makeFakeUser({
      terminalSettings: {
        _v: 1,
        position: "right",
        theme: "paper",
        font: { family: "JetBrains Mono", size: 14 },
        scrollbackLines: 5000,
        launcher: { label: "Claude", command: "claude" },
        launcherConsentedAt: null,
      },
    });
    const { result } = renderHook(() =>
      useTerminalSettings({ user, debounceMs: 0 })
    );
    expect(result.current.settings.position).toBe("right");
    expect(result.current.settings.theme).toBe("paper");
    expect(result.current.settings.font.size).toBe(14);
  });

  it("save() merges per-field; landed value preserves untouched fields", async () => {
    const user = makeFakeUser({
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
    const { result } = renderHook(() =>
      useTerminalSettings({
        user,
        debounceMs: 0,
        createBroadcaster: makeBroadcaster,
      })
    );

    await act(async () => {
      await result.current.save({ theme: "paper" });
    });

    // user.update was called with the merged object.
    expect(user.writes.length).toBe(1);
    const written = user.writes[0]!["terminalSettings"] as Record<
      string,
      unknown
    >;
    expect(written._v).toBe(1);
    expect(written.theme).toBe("paper");
    expect(written.position).toBe("bottom"); // preserved
    expect((written.font as { size: number }).size).toBe(13); // preserved
    // Local state matches.
    await waitFor(() => {
      expect(result.current.settings.theme).toBe("paper");
    });
  });

  it("save() transitions saveState idle → saving → saved → idle", async () => {
    const user = makeFakeUser({});
    const { result } = renderHook(() =>
      useTerminalSettings({
        user,
        debounceMs: 0,
        savedFadeMs: 5,
        createBroadcaster: makeBroadcaster,
      })
    );

    expect(result.current.saveState).toBe("idle");

    await act(async () => {
      await result.current.save({ theme: "paper" });
    });

    // 'saved' first, then auto-fade to 'idle'.
    expect(["saved", "idle"]).toContain(result.current.saveState);

    await waitFor(() => {
      expect(result.current.saveState).toBe("idle");
    });
  });

  it("throws BudgetError when serialized settings exceed 6 KB", async () => {
    const user = makeFakeUser({});
    const { result } = renderHook(() =>
      useTerminalSettings({
        user,
        debounceMs: 0,
        createBroadcaster: makeBroadcaster,
      })
    );

    // Build a string that pushes us over the 6KB budget.
    const giant = "x".repeat(SIZE_BUDGET_BYTES + 100);

    await act(async () => {
      await expect(
        result.current.save({
          launcher: { label: "Claude", command: giant },
        })
      ).rejects.toBeInstanceOf(TerminalSettingsBudgetError);
    });

    // saveState resolves to 'failed' after the budget rejection.
    expect(result.current.saveState).toBe("failed");
    // No writes hit Clerk.
    expect(user.writes.length).toBe(0);
  });

  it("retries once on conflict (landed value != merged value)", async () => {
    // The fake user accepts the write, then a 'fresh override' makes the
    // next read-back return mismatched data — first attempt fails, second
    // attempt succeeds (no override the second time).
    const user = makeFakeUser({
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
    let firstReadBack = true;
    const origReload = user.reload.bind(user);
    // Patch reload: after the first write, return a snapshot that doesn't
    // contain our update (simulating a race), forcing the retry.
    const origUpdate = user.update.bind(user);
    let nWrites = 0;
    user.update = async (patch) => {
      await origUpdate(patch);
      nWrites++;
      if (nWrites === 1) {
        // First write — simulate Clerk returning a stale snapshot that
        // makes the read-back NOT match our merged value, forcing retry.
        const ts = patch.publicMetadata["terminalSettings"] as Record<
          string,
          unknown
        >;
        user.setFreshOverride({
          terminalSettings: {
            ...ts,
            theme: "coal", // simulate landed != merged
          },
        });
      }
    };
    user.reload = async () => {
      await origReload();
      firstReadBack = false;
    };

    const { result } = renderHook(() =>
      useTerminalSettings({
        user,
        debounceMs: 0,
        createBroadcaster: makeBroadcaster,
      })
    );

    await act(async () => {
      await result.current.save({ theme: "paper" });
    });

    // Two writes happened — initial + retry.
    expect(nWrites).toBe(2);
    expect(result.current.saveState).toBe("saved");
    expect(firstReadBack).toBe(false);
  });

  it("flips to 'unsaved' when retry is also a conflict", async () => {
    const user = makeFakeUser({
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
    const origUpdate = user.update.bind(user);
    user.update = async (patch) => {
      await origUpdate(patch);
      // ALWAYS override the next read so both attempts conflict.
      const ts = patch.publicMetadata["terminalSettings"] as Record<
        string,
        unknown
      >;
      user.setFreshOverride({
        terminalSettings: { ...ts, theme: "coal" },
      });
    };

    const { result } = renderHook(() =>
      useTerminalSettings({
        user,
        debounceMs: 0,
        createBroadcaster: makeBroadcaster,
      })
    );

    await act(async () => {
      await result.current.save({ theme: "paper" });
    });
    expect(result.current.saveState).toBe("unsaved");
  });

  it("flips to 'unsaved' when save stays in-flight past unsavedThresholdMs", async () => {
    const user = makeFakeUser({});
    // Slow update — never resolves. We unmount before that matters; the hook's
    // unmount cleanup clears all timers so nothing leaks into the next test.
    user.update = () => new Promise<void>(() => {});

    const { result, unmount } = renderHook(() =>
      useTerminalSettings({
        user,
        debounceMs: 0,
        unsavedThresholdMs: 10,
        createBroadcaster: makeBroadcaster,
      })
    );

    await act(async () => {
      // Fire-and-forget — the save's promise will never settle (update hangs),
      // and we only care about the unsaved-threshold state transition.
      void result.current.save({ theme: "paper" });
      // Wait long enough for the unsaved-threshold timer to fire.
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(result.current.saveState).toBe("unsaved");
    unmount();
  });

  it("broadcasts the successful save via the injected broadcaster", async () => {
    const user = makeFakeUser({});
    const { result } = renderHook(() =>
      useTerminalSettings({
        user,
        debounceMs: 0,
        createBroadcaster: makeBroadcaster,
      })
    );

    await act(async () => {
      await result.current.save({ theme: "paper" });
    });

    expect(broadcasts.length).toBe(1);
    const msg = broadcasts[0] as {
      type: string;
      userId: string;
      settings: { theme: string };
    };
    expect(msg.type).toBe("dispatch-settings:applied");
    expect(msg.userId).toBe("user_test_1");
    expect(msg.settings.theme).toBe("paper");
  });
});
