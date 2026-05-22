// dispatch — use-panel-state (Phase 2 / Slice 3 → 5).
//
// Owns the visual-spec §9 panel-position state machine:
//   - position: "bottom" | "right"     (preference; S5 persists to Clerk)
//   - open:     boolean                 (CLOSED | OPEN per position)
//   - poppedOut: boolean                (orthogonal flag)
//
// S3 used a localStorage stub for persistence. S5 promotes position to a
// Clerk-backed setting via useTerminalSettings — TerminalPanel passes the
// Settings-resolved position via `syncedPosition` AND a `persist` callback
// that writes through to Clerk on toggle. localStorage stays as the offline
// fallback for `open` / `position` when no user is present.

import { useCallback, useEffect, useRef, useState } from "react";

export type PanelPosition = "bottom" | "right";

export interface PanelStateValue {
  position: PanelPosition;
  open: boolean;
  poppedOut: boolean;
}

export interface PanelStateApi {
  state: PanelStateValue;
  togglePosition(): void;
  setPosition(p: PanelPosition): void;
  open(): void;
  close(): void;
  toggle(): void;
  setPoppedOut(p: boolean): void;
}

const STORAGE_KEY = "dispatch::terminal::panel-state";

function loadFromStorage(): Partial<PanelStateValue> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PanelStateValue>;
    return parsed;
  } catch {
    return {};
  }
}

function persistToStorage(s: PanelStateValue): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ position: s.position, open: s.open })
    );
  } catch {
    /* private window — ignore */
  }
}

/**
 * usePanelState — the §9 state machine. Default position is `bottom`. Default
 * open is `true` so a fresh ticket-route mount shows the panel (per spec §3 —
 * Cmd+\` toggles it CLOSED).
 *
 * S5 integration: pass `syncedPosition` to drive position from
 * `useTerminalSettings().settings.position`, AND pass `persistPosition` so
 * toolbar toggles write through to Clerk. When both are omitted the hook
 * falls back to the S3 localStorage-only behavior for offline / pre-signin
 * development.
 */
export function usePanelState(opts?: {
  initialPosition?: PanelPosition;
  initialOpen?: boolean;
  /** Position pushed in from Settings (Clerk). When set, overrides local state. */
  syncedPosition?: PanelPosition;
  /** Called when the SE flips position via the toolbar shortcut. */
  persistPosition?: (next: PanelPosition) => void;
}): PanelStateApi {
  const persisted = loadFromStorage();
  const [state, setState] = useState<PanelStateValue>(() => ({
    position:
      opts?.syncedPosition ?? persisted.position ?? opts?.initialPosition ?? "bottom",
    open: persisted.open ?? opts?.initialOpen ?? true,
    poppedOut: false,
  }));

  // S5 — when the Settings-driven position changes (own-tab save OR
  // cross-window BroadcastChannel), reflect it in local state.
  useEffect(() => {
    if (opts?.syncedPosition === undefined) return;
    setState((s) =>
      s.position === opts.syncedPosition ? s : { ...s, position: opts.syncedPosition! }
    );
  }, [opts?.syncedPosition]);

  useEffect(() => {
    persistToStorage(state);
  }, [state]);

  // P2-4 fix (gate-review.md): the Clerk persistPosition side effect must
  // run OUTSIDE the setState reducer. React 18 StrictMode (dev) and React's
  // upcoming concurrent rendering call reducer functions TWICE for purity
  // checking; running the Clerk write inside the reducer would fire it
  // twice in StrictMode — exactly the double-write the gate review flagged.
  // The fix: setState updates pure state; a useEffect that watches
  // `state.position` fires the Clerk write exactly once per actual change.
  //
  // Tracking `isInitialMount` prevents the initial-state useEffect tick from
  // posting a "persist initial position" on every mount (which would be
  // noisy + would re-fire the StrictMode double-mount in dev).
  const persistPositionRef = useRef(opts?.persistPosition);
  persistPositionRef.current = opts?.persistPosition;
  const prevPersistedPositionRef = useRef<PanelPosition | null>(null);
  useEffect(() => {
    // Skip the initial-mount tick — we only want to persist USER-DRIVEN
    // changes, not the initial state load. `prevPersistedPositionRef` starts
    // null and is stamped on first run.
    if (prevPersistedPositionRef.current === null) {
      prevPersistedPositionRef.current = state.position;
      return;
    }
    if (prevPersistedPositionRef.current === state.position) return;
    prevPersistedPositionRef.current = state.position;
    try {
      persistPositionRef.current?.(state.position);
    } catch {
      /* persistence errors surface via SaveStateChip — don't block toggle */
    }
  }, [state.position]);

  const togglePosition = useCallback(() => {
    // Pure reducer — only flips state. The persist effect above fires the
    // Clerk write once after the state lands (StrictMode-safe).
    setState((s) => {
      const next: PanelPosition = s.position === "bottom" ? "right" : "bottom";
      return { ...s, position: next };
    });
  }, []);

  const setPosition = useCallback((p: PanelPosition) => {
    // Pure reducer — see togglePosition.
    setState((s) => (s.position === p ? s : { ...s, position: p }));
  }, []);

  const open = useCallback(() => {
    setState((s) => ({ ...s, open: true }));
  }, []);

  const close = useCallback(() => {
    setState((s) => ({ ...s, open: false }));
  }, []);

  const toggle = useCallback(() => {
    setState((s) => ({ ...s, open: !s.open }));
  }, []);

  const setPoppedOut = useCallback((p: boolean) => {
    setState((s) => ({ ...s, poppedOut: p }));
  }, []);

  return {
    state,
    togglePosition,
    setPosition,
    open,
    close,
    toggle,
    setPoppedOut,
  };
}
