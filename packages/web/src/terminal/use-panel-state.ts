// dispatch — use-panel-state (Phase 2 / Slice 3).
//
// Owns the visual-spec §9 panel-position state machine:
//   - position: "bottom" | "right"     (preference; S5 persists to Clerk)
//   - open:     boolean                 (CLOSED | OPEN per position)
//   - poppedOut: boolean                (orthogonal flag)
//
// For S3 the persistence layer is a localStorage stub — S5 swaps it for the
// real Clerk publicMetadata read/write through useTerminalSettings.

import { useCallback, useEffect, useState } from "react";

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
 * Cmd+\` toggles it CLOSED). S5's settings layer will set the initial value
 * from Clerk publicMetadata.
 */
export function usePanelState(opts?: {
  initialPosition?: PanelPosition;
  initialOpen?: boolean;
}): PanelStateApi {
  const persisted = loadFromStorage();
  const [state, setState] = useState<PanelStateValue>(() => ({
    position: persisted.position ?? opts?.initialPosition ?? "bottom",
    open: persisted.open ?? opts?.initialOpen ?? true,
    poppedOut: false,
  }));

  useEffect(() => {
    persistToStorage(state);
  }, [state]);

  const togglePosition = useCallback(() => {
    setState((s) => ({
      ...s,
      position: s.position === "bottom" ? "right" : "bottom",
    }));
  }, []);

  const setPosition = useCallback((p: PanelPosition) => {
    setState((s) => ({ ...s, position: p }));
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
