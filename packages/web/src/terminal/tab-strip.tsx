// dispatch — TabStrip (Phase 2 / Slice 6).
//
// v1: single-render contract. Renders exactly ONE `.term-tab-pill` for the
// active PTY (a non-interactive label) plus the disabled `.term-act.is-stub`
// `+` button. Visual spec §3.5/§3.6.
//
// v1: single-render; v1.5: flip .term-tabs to interactive + render per pty_id.
// Active-PTY pointer already supports the flip.

import React from "react";
import Ic from "../shell/Ic.js";

export interface TabStripProps {
  /** The ticket whose terminal panel is mounting this strip. */
  ticketId: string;
  /** The active PTY id, or null if no PTY is open yet. */
  activePtyId: string | null;
  /**
   * Shell name (e.g. `zsh`, `bash`) for the pill label. Optional — falls
   * back to "shell" when the Companion hasn't reported one yet.
   */
  shellName?: string;
  /**
   * Connection-dot class name — driven by transport status so the pill
   * shows a live indicator next to the label. Defaults to "conn-dot off".
   */
  connDotClass?: string;
}

/**
 * The toolbar tab strip. Mounts inside `.term-bar > .term-tabs` in
 * TerminalPanel. v1 renders one pill + a disabled `+` stub; v1.5 will iterate
 * the full pty list.
 */
export function TabStrip({
  ticketId,
  activePtyId,
  shellName,
  connDotClass,
}: TabStripProps): React.ReactElement {
  const shell = shellName ?? "shell";
  const label = activePtyId
    ? `${ticketId} · ${shell}`
    : `${ticketId} · (no shell)`;
  const dot = connDotClass ?? "conn-dot off";

  return (
    <div className="term-tabs">
      <div className="term-tab-pill" title={label} aria-label={label}>
        <span className={dot} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <button
        type="button"
        className="term-act is-stub"
        aria-disabled="true"
        disabled
        title="Multi-terminal coming in v1.5"
        aria-label="New terminal (coming in v1.5)"
      >
        <Ic.plus />
      </button>
    </div>
  );
}
