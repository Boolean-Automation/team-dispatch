// dispatch — SaveStateChip (Phase 2 / Slice 5).
//
// The `.set-savestate` chip that lives top-right of the Terminal settings
// form per visual-spec §6.4 + plan §S5 (Codex F6 persistent-unsaved indicator).
//
// States (`SaveState` from useTerminalSettings):
//   - 'idle'    — hidden (returns null).
//   - 'saving'  — amber `.conn-dot.warn` + "Saving…"
//   - 'saved'   — emerald `.conn-dot` + "Saved" (parent auto-fades to idle).
//   - 'unsaved' — persistent "Unsaved — your change isn't synced." + Retry.
//   - 'failed'  — red `.conn-dot off` + "Couldn't save settings" + Retry.

import React from "react";
import type { SaveState } from "./use-terminal-settings.js";

export interface SaveStateChipProps {
  /** The current save state — drives chip visibility + label. */
  state: SaveState;
  /** Called when the SE clicks Retry (unsaved + failed states). */
  onRetry: () => void;
}

export function SaveStateChip(props: SaveStateChipProps): React.ReactElement | null {
  const { state, onRetry } = props;

  if (state === "idle") return null;

  if (state === "saving") {
    return (
      <span
        className="set-savestate"
        data-testid="save-state-chip"
        data-state="saving"
        role="status"
        aria-live="polite"
      >
        <span className="conn-dot warn" aria-hidden="true" />
        <span>Saving…</span>
      </span>
    );
  }

  if (state === "saved") {
    return (
      <span
        className="set-savestate"
        data-testid="save-state-chip"
        data-state="saved"
        role="status"
        aria-live="polite"
      >
        <span className="conn-dot" aria-hidden="true" />
        <span>Saved</span>
      </span>
    );
  }

  if (state === "unsaved") {
    return (
      <span
        className="set-savestate"
        data-testid="save-state-chip"
        data-state="unsaved"
        role="status"
        aria-live="polite"
      >
        <span className="conn-dot warn" aria-hidden="true" />
        <span>Unsaved — your change isn't synced.</span>
        <button
          type="button"
          className="set-savestate-retry"
          onClick={onRetry}
          data-testid="save-state-retry"
        >
          Retry
        </button>
      </span>
    );
  }

  // failed
  return (
    <span
      className="set-savestate"
      data-testid="save-state-chip"
      data-state="failed"
      role="alert"
    >
      <span className="conn-dot off" aria-hidden="true" />
      <span>Couldn't save settings</span>
      <button
        type="button"
        className="set-savestate-retry"
        onClick={onRetry}
        data-testid="save-state-retry"
      >
        Retry
      </button>
    </span>
  );
}
