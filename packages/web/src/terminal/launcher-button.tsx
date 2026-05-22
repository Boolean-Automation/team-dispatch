// dispatch — LauncherButton (Phase 2 / Slice 4).
//
// The .term-launch pill that fills the §3.1 toolbar slot. Orange-accented per
// visual spec §5.3. Renders `Ic.bolt` + the configured launcher label.
//
// On click:
//   useLauncher().fire() — writes `command + \r` to the active PTY AND
//   fire-and-forgets a SHA-256-hashed audit POST.
//
// Disabled when there is no active PTY (`activePtyId === null`).

import React from "react";
import Ic from "../shell/Ic.js";
import {
  useLauncher,
  type LauncherConfig,
} from "./use-launcher.js";
import type { TerminalTransport } from "../ticket/terminal-transport.js";

export interface LauncherButtonProps {
  /** The active PTY id; null disables the button. */
  activePtyId: string | null;
  /** Ticket display id — sent through to the audit row. */
  ticketDisplayId: string;
  /** Active transport — the seam for the pty.write frame. */
  transport: TerminalTransport;
  /**
   * Optional override of the launcher config — Settings (S5) hosts a
   * proposed-but-not-yet-saved value during the consent modal flow.
   */
  override?: LauncherConfig;
  /** Optional bearer-token provider for the audit POST. */
  getAuthToken?: () => Promise<string | null>;
  /** Optional fetch injection — tests provide a stub. */
  fetchImpl?: typeof fetch;
  /** Optional digest injection — tests provide a stub. */
  digestImpl?: (
    algorithm: AlgorithmIdentifier,
    data: BufferSource
  ) => Promise<ArrayBuffer>;
}

export function LauncherButton(
  props: LauncherButtonProps
): React.ReactElement {
  const { launcher, fire, canFire, isFiring } = useLauncher({
    activePtyId: props.activePtyId,
    ticketDisplayId: props.ticketDisplayId,
    transport: props.transport,
    override: props.override,
    getAuthToken: props.getAuthToken,
    fetchImpl: props.fetchImpl,
    digestImpl: props.digestImpl,
  });

  const disabled = !canFire || isFiring;

  return (
    <button
      type="button"
      className="term-launch"
      onClick={() => {
        void fire();
      }}
      disabled={disabled}
      aria-disabled={disabled ? "true" : undefined}
      aria-label={`Launcher — types "${launcher.label}" into the shell`}
      title={
        canFire
          ? `Type "${launcher.command}" into the shell`
          : "Terminal not connected"
      }
      data-testid="terminal-launcher"
    >
      <Ic.bolt />
      <span>{launcher.label}</span>
    </button>
  );
}
