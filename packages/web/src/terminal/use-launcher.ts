// dispatch — useLauncher hook (Phase 2 / Slice 4).
//
// Reads the SE's configured launcher from Clerk publicMetadata, computes the
// command-hash client-side (the raw command NEVER leaves the browser), and
// exposes a `fire()` callback that:
//   (1) writes `command + '\r'` bytes to the active PTY via the transport;
//   (2) fires-and-forgets a POST /api/audit/launcher-fired with the SHA-256
//       hash + cosmetic label + ticket id.
//
// The audit POST failure does NOT block the launcher's keystroke macro —
// the shell-typing path is the user-visible behavior, the audit log is
// operator-side hygiene (Codex F5 binding).
//
// Default when publicMetadata.terminalSettings.launcher is absent:
//   { label: 'Claude', command: 'claude' }
//
// SECURITY POSTURE (visual spec §3.1 + plan §Slice 4):
//   The launcher is a KEYSTROKE MACRO, not an auth path. The bytes go RAW to
//   the SE's local shell via the Companion's PTY. No shell-escaping happens
//   on the dispatch side — escaping AFTER the bytes have already been sent is
//   security theater. The "first-edit consent" modal (separate component)
//   plus the Settings copy is where the user is informed about this.

import { useCallback, useMemo, useState } from "react";
import { useUser } from "@clerk/clerk-react";
import type { TerminalTransport } from "../ticket/terminal-transport.js";

/** Launcher shape stored in Clerk publicMetadata.terminalSettings.launcher. */
export interface LauncherConfig {
  /** Cosmetic label shown next to the bolt glyph (e.g. "Claude", "codex"). */
  label: string;
  /** The command bytes typed into the shell on click (no escaping). */
  command: string;
}

/** The default launcher when Clerk metadata is absent / empty. */
export const DEFAULT_LAUNCHER: LauncherConfig = {
  label: "Claude",
  command: "claude",
};

export interface UseLauncherOptions {
  /** The active PTY id to write bytes into. Null disables the launcher. */
  activePtyId: string | null;
  /** The ticket the panel is open on — passed through to the audit row. */
  ticketDisplayId: string;
  /** The active transport — `send({ t: 'pty.write', ... })` is the seam. */
  transport: TerminalTransport;
  /**
   * Optional override of the launcher config — Settings (S5) hosts a
   * proposed-but-not-yet-saved value during the consent modal flow. When
   * present, this wins over the Clerk-read launcher.
   */
  override?: LauncherConfig;
  /**
   * Optional auth-token provider — production wires Clerk's `getToken` here
   * so the audit POST carries `Authorization: Bearer <session>`. Tests
   * inject a no-token (the audit endpoint will 401, the launcher still
   * fires its keystroke — that's the contract).
   */
  getAuthToken?: () => Promise<string | null>;
  /**
   * Optional `fetch` injection for tests. Defaults to `window.fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional crypto.subtle digest injection for tests. Defaults to
   * `crypto.subtle.digest`. Production resolves to the browser's WebCrypto.
   */
  digestImpl?: (
    algorithm: AlgorithmIdentifier,
    data: BufferSource
  ) => Promise<ArrayBuffer>;
}

export interface UseLauncherResult {
  /** The resolved launcher (override > Clerk metadata > default). */
  launcher: LauncherConfig;
  /** Fire the launcher — writes bytes to the PTY + fire-and-forgets audit. */
  fire: () => Promise<void>;
  /** True while a `fire()` is in flight (the PTY write completes first). */
  isFiring: boolean;
  /** True iff a PTY is live and the button should be enabled. */
  canFire: boolean;
}

/**
 * Read the launcher config from Clerk publicMetadata, falling back to the
 * default. Tolerant of any partial / wrong-shape metadata (defensive cast).
 */
function readLauncherFromMetadata(
  publicMetadata: Record<string, unknown> | undefined
): LauncherConfig {
  if (!publicMetadata) return DEFAULT_LAUNCHER;
  const terminalSettings = publicMetadata["terminalSettings"];
  if (!terminalSettings || typeof terminalSettings !== "object") {
    return DEFAULT_LAUNCHER;
  }
  const launcher = (terminalSettings as Record<string, unknown>)["launcher"];
  if (!launcher || typeof launcher !== "object") return DEFAULT_LAUNCHER;
  const label = (launcher as Record<string, unknown>)["label"];
  const command = (launcher as Record<string, unknown>)["command"];
  if (typeof label !== "string" || typeof command !== "string") {
    return DEFAULT_LAUNCHER;
  }
  if (label.length === 0 || command.length === 0) return DEFAULT_LAUNCHER;
  return { label, command };
}

/**
 * Hex-encode an ArrayBuffer. Deliberately not pulled from a userland crypto
 * lib — `crypto.subtle.digest` returns an ArrayBuffer and the hex encoding
 * is a 6-line loop.
 */
function bufferToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    const byte = view[i]!;
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * SHA-256 hex digest of a UTF-8 string via the browser's WebCrypto.
 * No userland sha256 dependency.
 */
async function sha256Hex(
  input: string,
  digest: UseLauncherOptions["digestImpl"]
): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const fn = digest ?? crypto.subtle.digest.bind(crypto.subtle);
  const buf = await fn("SHA-256", bytes);
  return bufferToHex(buf);
}

export function useLauncher(opts: UseLauncherOptions): UseLauncherResult {
  const { activePtyId, ticketDisplayId, transport } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const digestImpl = opts.digestImpl;
  const getAuthToken = opts.getAuthToken;
  const override = opts.override;

  // useUser may be undefined in tests / pre-Clerk-setup — guard it.
  const { user } = useSafeClerkUser();
  const [isFiring, setIsFiring] = useState(false);

  const launcher = useMemo<LauncherConfig>(() => {
    if (override) return override;
    const meta = user?.publicMetadata as
      | Record<string, unknown>
      | undefined;
    return readLauncherFromMetadata(meta);
  }, [override, user?.publicMetadata]);

  const canFire = activePtyId !== null;

  const fire = useCallback(async () => {
    if (!activePtyId) return;
    setIsFiring(true);
    try {
      // (1) PTY write — the user-visible behavior. Send the bytes + Enter.
      // This is intentionally fired BEFORE the audit POST so an audit
      // network blip never delays the keystroke macro.
      try {
        transport.send({
          t: "pty.write",
          pty_id: activePtyId,
          data: launcher.command + "\r",
        });
      } catch {
        // Transport torn down between read and click. Surface nothing — the
        // panel's connection-state chrome already speaks to this.
      }

      // (2) Audit POST — fire-and-forget. Failures DO NOT block the launcher.
      try {
        const command_hash = await sha256Hex(launcher.command, digestImpl);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (getAuthToken) {
          const token = await getAuthToken();
          if (token) headers["Authorization"] = `Bearer ${token}`;
        }
        // The actual fetch is not awaited for completion semantics — but we
        // do await the body construction so the hash is computed once.
        void fetchImpl("/api/audit/launcher-fired", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ticket_display_id: ticketDisplayId,
            command_hash,
            label: launcher.label,
          }),
        }).catch(() => {
          /* fire-and-forget — operator-side hygiene */
        });
      } catch {
        /* hash failed (no WebCrypto) — still don't block the launcher */
      }
    } finally {
      setIsFiring(false);
    }
  }, [
    activePtyId,
    transport,
    launcher.command,
    launcher.label,
    ticketDisplayId,
    digestImpl,
    fetchImpl,
    getAuthToken,
  ]);

  return { launcher, fire, isFiring, canFire };
}

// ── Internal: safe useUser wrapper ───────────────────────────────────────────
//
// In tests we render <LauncherButton> outside a ClerkProvider. The real
// `useUser()` throws in that case. We catch the throw and return a null user
// so the hook still resolves to DEFAULT_LAUNCHER.

function useSafeClerkUser(): { user: { publicMetadata?: unknown } | null } {
  try {
    const result = useUser();
    return { user: result.user ?? null };
  } catch {
    return { user: null };
  }
}
