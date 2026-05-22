// dispatch — LauncherConsentModal (Phase 2 / Slice 4).
//
// Codex F5 binding. The first-edit interstitial modal that fires when an SE
// saves a non-default launcher command AND `launcherConsentedAt` is absent
// OR older than 12 months.
//
// Modal copy (verbatim per plan §Slice 4):
//   This button types the command into your real local shell.
//   It is not sandboxed. Only use commands you would type yourself.
//   The dispatch backend logs each click (timestamp + ticket + a hash of the
//   command — not the command itself).
//   [ Cancel ]  [ I understand — save launcher ]
//
// CONTRACT:
//   This is a PURE PRESENTATION COMPONENT. It does NOT write to Clerk
//   publicMetadata itself. On confirm, it calls `onConfirm({
//   launcherConsentedAt: ISO8601(now) })` so the parent (Settings page in
//   S5, or a smoke harness in S4 for the L1 capture) can persist the
//   consent record alongside the launcher write.
//
// FOCUS TRAP + KEYBOARD:
//   - Escape: fires onCancel.
//   - Tab/Shift+Tab: keeps focus inside the modal (loops between Cancel and
//     Confirm).
//   - On mount: focuses the Cancel button (the safer default).

import React, { useCallback, useEffect, useRef } from "react";

export interface LauncherConsentDecision {
  /** ISO8601 timestamp of when consent was granted. Stable across the call. */
  launcherConsentedAt: string;
}

export interface LauncherConsentModalProps {
  /**
   * True when the parent has determined the modal must show: the SE is
   * saving a non-default launcher AND `launcherConsentedAt` is absent or
   * older than 12 months. When false, the component renders nothing.
   */
  open: boolean;
  /** The pending command (display only — the modal does not echo it). */
  pendingCommand: string;
  /** Called when the SE confirms — parent persists the decision to Clerk. */
  onConfirm: (decision: LauncherConsentDecision) => void;
  /** Called when the SE cancels (Cancel button OR Escape OR backdrop). */
  onCancel: () => void;
  /**
   * Optional clock injection for tests so the timestamp is deterministic.
   * Defaults to `() => new Date()`.
   */
  now?: () => Date;
}

export function LauncherConsentModal(
  props: LauncherConsentModalProps
): React.ReactElement | null {
  const { open, onConfirm, onCancel } = props;
  const now = props.now ?? (() => new Date());

  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Focus the Cancel button on mount — the safer default.
  useEffect(() => {
    if (!open) return;
    // Defer one tick so the elements are in the DOM.
    const t = window.setTimeout(() => {
      cancelRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Escape → onCancel.
  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  const handleConfirm = useCallback(() => {
    onConfirm({ launcherConsentedAt: now().toISOString() });
  }, [onConfirm, now]);

  // Focus-trap: Tab from the last focusable wraps to the first; Shift+Tab
  // from the first wraps to the last. With only Cancel + Confirm in the
  // dialog this collapses to a 2-element ring.
  const onDialogKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLDivElement>) => {
      if (ev.key !== "Tab") return;
      const cancel = cancelRef.current;
      const confirm = confirmRef.current;
      if (!cancel || !confirm) return;
      const active = document.activeElement;
      if (ev.shiftKey) {
        if (active === cancel) {
          ev.preventDefault();
          confirm.focus();
        }
      } else {
        if (active === confirm) {
          ev.preventDefault();
          cancel.focus();
        }
      }
    },
    []
  );

  if (!open) return null;

  return (
    <div
      className="launcher-consent-backdrop"
      role="presentation"
      data-testid="launcher-consent-backdrop"
      onClick={(e) => {
        // Clicking the backdrop (not the dialog) cancels.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="launcher-consent-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launcher-consent-title"
        aria-describedby="launcher-consent-body"
        data-testid="launcher-consent-modal"
        onKeyDown={onDialogKeyDown}
      >
        <h2
          id="launcher-consent-title"
          className="launcher-consent-title"
        >
          This button types the command into your real local shell.
        </h2>
        <div
          id="launcher-consent-body"
          className="launcher-consent-body"
        >
          <p>
            It is not sandboxed. Only use commands you would type yourself.
          </p>
          <p>
            The dispatch backend logs each click (timestamp + ticket + a hash
            of the command — not the command itself).
          </p>
        </div>
        <div className="launcher-consent-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn-outline"
            onClick={onCancel}
            data-testid="launcher-consent-cancel"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn-primary"
            onClick={handleConfirm}
            data-testid="launcher-consent-confirm"
          >
            I understand — save launcher
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Helper for the parent (S5 Settings page) to decide whether the modal
 * should fire. Exported here so the consent contract lives next to the
 * component that enforces it.
 *
 * Fires when:
 *  - The pending command is NOT the default `"claude"` (case-sensitive,
 *    matches the DEFAULT_LAUNCHER from use-launcher.ts), AND
 *  - `launcherConsentedAt` is absent OR older than 12 months from `now`.
 */
export function shouldFireConsentModal(opts: {
  pendingCommand: string;
  previousConsentedAt: string | null | undefined;
  now?: Date;
}): boolean {
  if (opts.pendingCommand === "claude") return false;
  if (!opts.previousConsentedAt) return true;
  const consented = Date.parse(opts.previousConsentedAt);
  if (Number.isNaN(consented)) return true;
  const now = (opts.now ?? new Date()).getTime();
  const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
  return now - consented > TWELVE_MONTHS_MS;
}
