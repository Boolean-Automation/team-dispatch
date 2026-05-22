// dispatch — useTerminalSettings hook (Phase 2 / Slice 5).
//
// Single source of truth for Phase 2 terminal Settings. Owns:
//   - Reading the `publicMetadata.terminalSettings` namespace from Clerk
//     (with defaults when absent / partial).
//   - Saving a partial update with versioned + per-field-merged
//     read-modify-write (Codex F6 binding):
//       1. user.reload() to fetch fresh metadata (don't trust the cached snapshot).
//       2. Per-field merge the proposed partial into the fresh value.
//       3. user.update({ publicMetadata: { ...other, terminalSettings: { _v: 1, ...merged } } }).
//       4. Read-back; if landed != merged, retry once. After that → 'failed'.
//   - Enforcing a 6 KB size budget on the serialized terminalSettings object
//     (Clerk's publicMetadata cap is ~8 KB; reserve 2 KB for other namespaces).
//   - The save-state machine: idle → saving → saved → idle (auto-fade 1.5s);
//     5s+ in-flight OR failure → 'unsaved' persistent (until retry or reload).
//   - Cross-window broadcast: every successful save posts to a
//     `dispatch-settings-<user_id>` BroadcastChannel so opener + popout
//     terminals propagate theme/font/scrollback changes live.
//   - Debounced auto-save (500ms per visual spec §6.4).
//
// CONTRACT:
//   This hook accepts a `userClient` argument so tests can inject a fake
//   Clerk-shaped object. Production wires it from `useUser()` + the augmented
//   methods `user.reload()` and `user.update()`. The hook never imports
//   `@clerk/clerk-react` directly — the consumer (a thin wrapper component)
//   does that, so tests stay clean.

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

/** All five terminal Settings fields, plus the launcher consent timestamp. */
export interface TerminalSettings {
  /** Panel position — bottom (default) or right. */
  position: "bottom" | "right";
  /** Theme name — visual spec §6.3 row 3. */
  theme: "coal" | "paper" | "mono" | "highContrast" | "solarizedDark";
  /** Font family + size. */
  font: {
    family: string;
    size: 11 | 12 | 13 | 14 | 15;
  };
  /** xterm scrollback lines — bounded set per visual spec §6.3 row 5. */
  scrollbackLines: 1000 | 5000 | 10000;
  /** Launcher label + command — see launcher consent modal (S4). */
  launcher: {
    label: string;
    command: string;
  };
  /** ISO timestamp of the most recent launcher consent (or null). */
  launcherConsentedAt: string | null;
}

/** The on-disk shape — adds the `_v: 1` discriminator. */
export interface StoredTerminalSettings extends TerminalSettings {
  _v: 1;
}

/** Defaults applied when publicMetadata.terminalSettings is missing / partial. */
export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  position: "bottom",
  theme: "coal",
  font: { family: "JetBrains Mono", size: 13 },
  scrollbackLines: 10000,
  launcher: { label: "Claude", command: "claude" },
  launcherConsentedAt: null,
};

/** SaveState machine — drives the SaveStateChip UI. */
export type SaveState = "idle" | "saving" | "saved" | "unsaved" | "failed";

/** The shape of the Clerk-like user client this hook depends on. */
export interface ClerkLikeUser {
  /** Stable Clerk user id (used to name the BroadcastChannel). */
  id: string;
  /** Read-only snapshot — the hook calls `reload()` before each write. */
  publicMetadata: Record<string, unknown>;
  /** Force-refresh of `publicMetadata` from the server. */
  reload(): Promise<void>;
  /** Patch the user's metadata. Last-write-wins, per Clerk semantics. */
  update(patch: {
    publicMetadata: Record<string, unknown>;
  }): Promise<void>;
}

/** Optional broadcaster the hook uses for cross-window sync (mockable). */
export interface SettingsBroadcaster {
  postMessage(payload: unknown): void;
  close(): void;
}

export interface UseTerminalSettingsOptions {
  /** The Clerk-like user. Pass null when not signed in (hook returns defaults). */
  user: ClerkLikeUser | null;
  /** Debounce ms — defaults to 500 per visual spec §6.4. */
  debounceMs?: number;
  /**
   * Unsaved-threshold ms — saves still 'saving' past this duration flip to
   * 'unsaved'. Defaults to 5000.
   */
  unsavedThresholdMs?: number;
  /** Auto-fade ms for 'saved' state. Defaults to 1500. */
  savedFadeMs?: number;
  /** Optional broadcaster factory — defaults to a real BroadcastChannel. */
  createBroadcaster?: (channelName: string) => SettingsBroadcaster;
  /** Test seam for setTimeout / clearTimeout / Date.now. */
  clock?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    now: () => number;
  };
}

export interface UseTerminalSettingsResult {
  /** The current (merged-with-defaults) terminal settings. */
  settings: TerminalSettings;
  /**
   * Save a partial update. Per-field merged against fresh server metadata;
   * retries once on a detected conflict. Throws synchronously if the result
   * would exceed the 6 KB budget. Resolves when the save state has settled
   * (success, retry-success, or failed).
   */
  save: (partial: Partial<TerminalSettings>) => Promise<void>;
  /** Current save state — drives the SaveStateChip. */
  saveState: SaveState;
  /** Retry an unsaved/failed save with the last attempted partial. */
  retry: () => Promise<void>;
}

// ── Internals ────────────────────────────────────────────────────────────────

/** 6 KB cap — Clerk publicMetadata is ~8 KB total, reserve 2 KB. */
export const SIZE_BUDGET_BYTES = 6 * 1024;

/** Class of error thrown when the proposed save exceeds the budget. */
export class TerminalSettingsBudgetError extends Error {
  constructor(actual: number, budget: number) {
    super(
      `terminalSettings serialized size ${actual} bytes exceeds ${budget} byte budget`
    );
    this.name = "TerminalSettingsBudgetError";
  }
}

/** The BroadcastChannel name per spec §Slice 5. */
export function broadcastChannelName(userId: string): string {
  return `dispatch-settings-${userId}`;
}

/**
 * Defensive read — coerces an arbitrary metadata object to a TerminalSettings
 * by merging with DEFAULT_TERMINAL_SETTINGS. Wrong-shape fields fall back to
 * the default for that field individually so a malformed save in one tab
 * doesn't poison the others.
 */
export function readTerminalSettings(
  metadata: Record<string, unknown> | undefined | null
): TerminalSettings {
  const raw = (metadata?.["terminalSettings"] ?? null) as
    | Record<string, unknown>
    | null;
  if (!raw || typeof raw !== "object") {
    return DEFAULT_TERMINAL_SETTINGS;
  }
  const merged: TerminalSettings = {
    ...DEFAULT_TERMINAL_SETTINGS,
  };

  if (raw["position"] === "bottom" || raw["position"] === "right") {
    merged.position = raw["position"];
  }
  if (
    raw["theme"] === "coal" ||
    raw["theme"] === "paper" ||
    raw["theme"] === "mono" ||
    raw["theme"] === "highContrast" ||
    raw["theme"] === "solarizedDark"
  ) {
    merged.theme = raw["theme"];
  }
  if (raw["font"] && typeof raw["font"] === "object") {
    const font = raw["font"] as Record<string, unknown>;
    const size = font["size"];
    const family = font["family"];
    if (typeof family === "string" && family.length > 0) {
      merged.font = { ...merged.font, family };
    }
    if (
      size === 11 ||
      size === 12 ||
      size === 13 ||
      size === 14 ||
      size === 15
    ) {
      merged.font = { ...merged.font, size };
    }
  }
  if (
    raw["scrollbackLines"] === 1000 ||
    raw["scrollbackLines"] === 5000 ||
    raw["scrollbackLines"] === 10000
  ) {
    merged.scrollbackLines = raw["scrollbackLines"];
  }
  if (raw["launcher"] && typeof raw["launcher"] === "object") {
    const l = raw["launcher"] as Record<string, unknown>;
    const label = l["label"];
    const command = l["command"];
    if (
      typeof label === "string" &&
      label.length > 0 &&
      typeof command === "string" &&
      command.length > 0
    ) {
      merged.launcher = { label, command };
    }
  }
  if (typeof raw["launcherConsentedAt"] === "string") {
    merged.launcherConsentedAt = raw["launcherConsentedAt"];
  } else if (raw["launcherConsentedAt"] === null) {
    merged.launcherConsentedAt = null;
  }
  return merged;
}

/**
 * Per-field merge: the proposed partial overrides field-by-field, never as a
 * whole-object replacement. `font` is merged shallow (so a tab changing only
 * `font.size` doesn't blow away `font.family`); same for `launcher`.
 */
export function mergeTerminalSettings(
  base: TerminalSettings,
  partial: Partial<TerminalSettings>
): TerminalSettings {
  const next: TerminalSettings = { ...base };
  if (partial.position !== undefined) next.position = partial.position;
  if (partial.theme !== undefined) next.theme = partial.theme;
  if (partial.font !== undefined) {
    next.font = { ...base.font, ...partial.font };
  }
  if (partial.scrollbackLines !== undefined) {
    next.scrollbackLines = partial.scrollbackLines;
  }
  if (partial.launcher !== undefined) {
    next.launcher = { ...base.launcher, ...partial.launcher };
  }
  if (partial.launcherConsentedAt !== undefined) {
    next.launcherConsentedAt = partial.launcherConsentedAt;
  }
  return next;
}

/** Build the on-disk shape with the `_v: 1` discriminator. */
function withVersion(settings: TerminalSettings): StoredTerminalSettings {
  return { _v: 1, ...settings };
}

/** Approximate UTF-8 byte size of a JSON serialization. */
function serializedSize(value: unknown): number {
  const json = JSON.stringify(value);
  return new TextEncoder().encode(json).length;
}

/**
 * Compare two settings shapes for equality — used to verify a write landed.
 * Only the FIVE persisted fields + launcherConsentedAt + _v count.
 */
function settingsEqual(a: TerminalSettings, b: TerminalSettings): boolean {
  return (
    a.position === b.position &&
    a.theme === b.theme &&
    a.font.family === b.font.family &&
    a.font.size === b.font.size &&
    a.scrollbackLines === b.scrollbackLines &&
    a.launcher.label === b.launcher.label &&
    a.launcher.command === b.launcher.command &&
    a.launcherConsentedAt === b.launcherConsentedAt
  );
}

// ── The hook ─────────────────────────────────────────────────────────────────

export function useTerminalSettings(
  opts: UseTerminalSettingsOptions
): UseTerminalSettingsResult {
  const { user } = opts;
  const debounceMs = opts.debounceMs ?? 500;
  const unsavedThresholdMs = opts.unsavedThresholdMs ?? 5000;
  const savedFadeMs = opts.savedFadeMs ?? 1500;
  const createBroadcaster = opts.createBroadcaster;

  // Initial settings come from a synchronous read of the (cached) snapshot.
  // `save()` reloads + per-field-merges, so the snapshot is only a starting
  // point — concurrent updates from another tab WILL show up after the next
  // save (which reloads), and the BroadcastChannel handler below refreshes
  // them between saves.
  //
  // The lazy `useState` initializer runs ONCE on mount — that's the exact
  // semantic we want here (a `useMemo([])` would do the same, with the same
  // intentional-empty-deps gotcha).
  const [settings, setSettings] = useState<TerminalSettings>(() =>
    readTerminalSettings(user?.publicMetadata)
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // Most-recent partial — held for retry().
  const lastPartialRef = useRef<Partial<TerminalSettings> | null>(null);
  // Debounce timer.
  const debounceTimerRef = useRef<unknown>(null);
  // 'saved' auto-fade timer.
  const fadeTimerRef = useRef<unknown>(null);
  // 'unsaved' threshold timer.
  const unsavedTimerRef = useRef<unknown>(null);

  // Stable clock — opts.clock is captured once. Avoiding inline object literal
  // here is important: a fresh `clock` per render invalidates effect deps and
  // would tear down the cleanup useEffect every render, clobbering the fade /
  // unsaved-threshold timers mid-flight.
  const clockRef = useRef<NonNullable<UseTerminalSettingsOptions["clock"]>>(
    opts.clock ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    }
  );
  const clock = clockRef.current;

  // BroadcastChannel — opener + popout sync. Created when user is known.
  const broadcasterRef = useRef<SettingsBroadcaster | null>(null);
  useEffect(() => {
    if (!user) return;
    const name = broadcastChannelName(user.id);
    const bc = createBroadcaster
      ? createBroadcaster(name)
      : defaultBroadcaster(name);
    broadcasterRef.current = bc;
    return () => {
      try {
        bc.close();
      } catch {
        /* already closed */
      }
      broadcasterRef.current = null;
    };
  }, [user, createBroadcaster]);

  // Clear any pending timers on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clock.clearTimeout(debounceTimerRef.current);
      if (fadeTimerRef.current) clock.clearTimeout(fadeTimerRef.current);
      if (unsavedTimerRef.current) clock.clearTimeout(unsavedTimerRef.current);
    };
  }, [clock]);

  /**
   * Perform the actual read-modify-write against the Clerk-like user.
   * Returns true on success, false on conflict-after-retry / hard failure.
   */
  const performWrite = useCallback(
    async (
      target: ClerkLikeUser,
      partial: Partial<TerminalSettings>
    ): Promise<{ ok: boolean; merged?: TerminalSettings }> => {
      // Up to 2 attempts (initial + one retry on conflict).
      for (let attempt = 0; attempt < 2; attempt++) {
        // 1. Read fresh.
        await target.reload();
        const fresh = readTerminalSettings(target.publicMetadata);
        // 2. Per-field merge.
        const merged = mergeTerminalSettings(fresh, partial);
        const stored = withVersion(merged);

        // 3. Size budget check — throw immediately if exceeded.
        const size = serializedSize(stored);
        if (size > SIZE_BUDGET_BYTES) {
          throw new TerminalSettingsBudgetError(size, SIZE_BUDGET_BYTES);
        }

        // 4. Write — preserve any sibling namespaces in publicMetadata.
        const other = { ...target.publicMetadata };
        delete other["terminalSettings"];
        await target.update({
          publicMetadata: { ...other, terminalSettings: stored },
        });

        // 5. Read-back: verify the merged value landed.
        await target.reload();
        const landed = readTerminalSettings(target.publicMetadata);
        if (settingsEqual(landed, merged)) {
          return { ok: true, merged };
        }
        // Conflict — fall through to the next attempt.
      }
      return { ok: false };
    },
    []
  );

  /** Optimistic local update + schedule a debounced save. */
  const save = useCallback(
    (partial: Partial<TerminalSettings>): Promise<void> => {
      lastPartialRef.current = { ...lastPartialRef.current, ...partial };

      // Optimistic local update.
      setSettings((prev) => mergeTerminalSettings(prev, partial));

      // Clear any pending debounce + fade timers.
      if (debounceTimerRef.current) {
        clock.clearTimeout(debounceTimerRef.current);
      }
      if (fadeTimerRef.current) {
        clock.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }

      return new Promise<void>((resolve, reject) => {
        debounceTimerRef.current = clock.setTimeout(async () => {
          debounceTimerRef.current = null;
          if (!user) {
            // No user — local-only save (e.g. pre-signin dev). Treat as success.
            setSaveState("saved");
            scheduleFade();
            resolve();
            return;
          }
          setSaveState("saving");

          // Start the unsaved-threshold timer.
          if (unsavedTimerRef.current) {
            clock.clearTimeout(unsavedTimerRef.current);
          }
          unsavedTimerRef.current = clock.setTimeout(() => {
            unsavedTimerRef.current = null;
            // If still saving after threshold, surface 'unsaved'.
            setSaveState((s) => (s === "saving" ? "unsaved" : s));
          }, unsavedThresholdMs);

          const aggregated = lastPartialRef.current ?? partial;
          try {
            const result = await performWrite(user, aggregated);
            // Clear unsaved-threshold timer once write resolves.
            if (unsavedTimerRef.current) {
              clock.clearTimeout(unsavedTimerRef.current);
              unsavedTimerRef.current = null;
            }
            if (result.ok && result.merged) {
              setSaveState("saved");
              scheduleFade();
              // Broadcast to opener + popout windows.
              try {
                broadcasterRef.current?.postMessage({
                  type: "dispatch-settings:applied",
                  userId: user.id,
                  settings: result.merged,
                });
              } catch {
                /* channel closed — non-fatal */
              }
              resolve();
            } else {
              setSaveState("unsaved");
              resolve();
            }
          } catch (err) {
            if (unsavedTimerRef.current) {
              clock.clearTimeout(unsavedTimerRef.current);
              unsavedTimerRef.current = null;
            }
            // Budget errors and network errors both land here.
            setSaveState(
              err instanceof TerminalSettingsBudgetError ? "failed" : "unsaved"
            );
            reject(err);
          }
        }, debounceMs);
      });

      function scheduleFade(): void {
        if (fadeTimerRef.current) clock.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = clock.setTimeout(() => {
          fadeTimerRef.current = null;
          setSaveState((s) => (s === "saved" ? "idle" : s));
        }, savedFadeMs);
      }
    },
    [
      user,
      debounceMs,
      unsavedThresholdMs,
      savedFadeMs,
      performWrite,
      clock,
    ]
  );

  const retry = useCallback((): Promise<void> => {
    if (!lastPartialRef.current) return Promise.resolve();
    return save(lastPartialRef.current);
  }, [save]);

  // Subscribe to BroadcastChannel — when another tab applies settings, update
  // local state so the UI follows without a page reload.
  useEffect(() => {
    if (!user) return;
    const name = broadcastChannelName(user.id);
    const handler = (payload: unknown) => {
      if (
        payload &&
        typeof payload === "object" &&
        (payload as { type?: unknown }).type === "dispatch-settings:applied"
      ) {
        const next = (payload as { settings?: unknown }).settings;
        if (next && typeof next === "object") {
          setSettings((prev) =>
            mergeTerminalSettings(
              prev,
              next as Partial<TerminalSettings>
            )
          );
        }
      }
    };
    // Real BroadcastChannel listens via 'message' events; the default
    // broadcaster wraps that. For tests, opts.createBroadcaster returns a
    // mock that bridges its own emit; subscription is done by exposing the
    // broadcaster's underlying onMessage when available.
    let cleanup: (() => void) | null = null;
    if (typeof BroadcastChannel !== "undefined" && !createBroadcaster) {
      try {
        const bc = new BroadcastChannel(name);
        const wrapped = (ev: MessageEvent) => handler(ev.data);
        bc.addEventListener("message", wrapped);
        cleanup = () => {
          bc.removeEventListener("message", wrapped);
          try {
            bc.close();
          } catch {
            /* already closed */
          }
        };
      } catch {
        /* environment without BroadcastChannel — skip */
      }
    }
    return () => {
      cleanup?.();
    };
  }, [user, createBroadcaster]);

  return { settings, save, saveState, retry };
}

// ── Default BroadcastChannel-backed broadcaster ──────────────────────────────

function defaultBroadcaster(name: string): SettingsBroadcaster {
  if (typeof BroadcastChannel === "undefined") {
    // Environments without BroadcastChannel (older Safari, some test runners)
    // get a no-op so the hook still functions; cross-window sync just won't fire.
    return {
      postMessage() {
        /* no-op */
      },
      close() {
        /* no-op */
      },
    };
  }
  const bc = new BroadcastChannel(name);
  return {
    postMessage(payload: unknown) {
      try {
        bc.postMessage(payload);
      } catch {
        /* channel closed */
      }
    },
    close() {
      try {
        bc.close();
      } catch {
        /* already closed */
      }
    },
  };
}
