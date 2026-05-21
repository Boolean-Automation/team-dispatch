// dispatch — PanelTerminal: the embedded claude-code terminal panel (Spike #1).
//
// Renders the locked Dispatch v2 `.term` design with xterm.js mounted inside
// `.term-body`. Depends on `useCompanion` — hence on the `TerminalTransport`
// SEAM, never on the Companion WebSocket directly (plan risk #6). When the
// session is in a failure state it renders the matching `.term-fail` block
// from the visual spec §3 instead of the xterm host.
//
// The Phase-1 `.term-prompt` mock input is NOT rendered — xterm owns input.

import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Ic from "../shell/Ic";
import type { Ticket } from "../lib/types";
import type { TerminalTransport, ConnectionState } from "./terminal-transport.js";
import { useCompanion } from "./use-companion-session.js";

interface PanelTerminalProps {
  ticket: Ticket;
  /**
   * The Account slug for the ticket's client, when the parent has the Account
   * loaded. Threaded into the Companion context-injection payload (A15 /
   * OQ-S2) so the browser path injects the client slug.
   */
  clientSlug?: string;
  /**
   * Optional transport override. The spike substitutes the
   * `FallbackTransportStub` here to prove the seam — the component accepts it
   * UNMODIFIED. Production omits this and the real WS transport is used.
   */
  transport?: TerminalTransport;
}

// ── xterm.js theme — the locked Dispatch v2 palette (visual spec §4) ─────────
// Every value is a literal copy of the locked `.term` rule / shell.css tokens.
// Do NOT invent colours.
const XTERM_THEME = {
  background: "#07101F",
  foreground: "#94A3B8",
  cursor: "#10B981",
  cursorAccent: "#07101F",
  selectionBackground: "#1E293B",
  black: "#0B1120",
  red: "#EF4444",
  green: "#10B981",
  yellow: "#FBBF24",
  blue: "#3B82F6",
  magenta: "#A855F7",
  cyan: "#6EE7B7",
  white: "#F1F5F9",
  brightBlack: "#64748B",
  brightRed: "#FCA5A5",
  brightGreen: "#6EE7B7",
  brightYellow: "#FCD34D",
  brightBlue: "#93C5FD",
  brightMagenta: "#C4B5FD",
  brightCyan: "#6EE7B7",
  brightWhite: "#FFFFFF",
};

/** The states for which the panel renders xterm rather than a failure block. */
const LIVE_STATES: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  "connecting",
  "connected",
]);

export function PanelTerminal({
  ticket,
  clientSlug,
  transport,
}: PanelTerminalProps) {
  // Thread the Ticket + Account context into the context-injection preamble
  // (A15 / OQ-S2): status from the Ticket, the client slug from the Account
  // (when the parent has it loaded), and the message preview as the ticket
  // title — the dispatch `Ticket` shape carries no separate title field, so
  // `preview` is the closest honest human-readable label. This matches the
  // payload the headless capture proved (Codex P2).
  const companion = useCompanion({
    ticketId: ticket.displayId,
    meta: {
      status: ticket.status,
      clientSlug,
      title: ticket.preview,
    },
    transport,
  });
  const { status } = companion;

  const xtermHostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const isLive = LIVE_STATES.has(status.state);

  // ── Mount xterm.js when the panel is in a live state ───────────────────────
  useEffect(() => {
    if (!isLive) return;
    const host = xtermHostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11.5,
      lineHeight: 1.55,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 2000,
      theme: XTERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // PTY output (data frames) → xterm.
    const unsubscribe = companion.onFrame((frame) => {
      if (frame.t === "data") {
        term.write(frame.d);
      }
    });

    // Keystrokes → the Companion as `data` frames.
    const keyDisposable = term.onData((d) => {
      companion.send({ t: "data", d });
    });

    // Panel resize → fit → `resize` frame (AC A2).
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        companion.resize(term.cols, term.rows);
      } catch {
        /* host detached mid-resize */
      }
    });
    resizeObserver.observe(host);

    // Send the initial size once.
    companion.resize(term.cols, term.rows);

    return () => {
      unsubscribe();
      keyDisposable.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // companion methods are stable; isLive gates the mount.
  }, [isLive, companion]);

  return (
    <div className="term">
      <TermHead status={status} />
      <div className="term-body">
        {isLive ? (
          <div className="xterm-host" ref={xtermHostRef} />
        ) : (
          <TermFailure state={status.state} onRetry={companion.retry} />
        )}
      </div>
    </div>
  );
}

// ── Connection-state header (visual spec §2) ─────────────────────────────────

function TermHead({ status }: { status: ReturnType<typeof useCompanion>["status"] }) {
  let dotClass = "conn-dot off";
  let label = "not connected";

  if (status.state === "connecting") {
    dotClass = "conn-dot warn";
    label = "connecting…";
  } else if (status.state === "connected") {
    dotClass = "conn-dot";
    label = status.sessionId
      ? `session ${status.sessionId.slice(0, 4)}`
      : "connected";
  }

  return (
    <div className="term-head">
      <span className={dotClass} aria-hidden="true" />
      <span>{label}</span>
      <span className="spacer" />
    </div>
  );
}

// ── The three failure-mode states (visual spec §3) ───────────────────────────

interface FailureContent {
  iconWarn: boolean;
  icon: "terminal" | "power";
  title: string;
  message: string;
  hint: string;
  showRetry: boolean;
}

/**
 * Map a connection state to its failure-block content. State (a) "not
 * installed" and state (b) "offline" both surface as `not-detected` at spike
 * fidelity — the panel cannot distinguish "never installed" from "installed
 * but not running" without an installer, so it shows the recoverable
 * (offline) framing with a Retry. States (c)–(h) get their own framing.
 */
function failureContent(state: ConnectionState): FailureContent {
  switch (state) {
    case "claude-unusable":
    case "local-permission-denied":
      // Visual spec §3 state (c) — Companion online, no usable claude session.
      return {
        iconWarn: true,
        icon: "terminal",
        title: "Claude Code needs attention",
        message:
          "The Companion connected, but it couldn't start a Claude Code session. " +
          "Claude Code may not be installed, not on your PATH, or not logged in. " +
          "Open a terminal and check.",
        hint: "claude --version",
        showRetry: true,
      };
    case "quota-limited":
      return {
        iconWarn: true,
        icon: "terminal",
        title: "Claude Code is rate-limited",
        message:
          "Claude Code hit a usage or rate limit on your subscription. Wait a " +
          "moment, then retry.",
        hint: "claude --version",
        showRetry: true,
      };
    case "version-mismatch":
      return {
        iconWarn: true,
        icon: "power",
        title: "Companion is out of date",
        message:
          "The Companion on your Mac is a different version than this panel " +
          "expects. Update the Companion, then retry.",
        hint: "dispatch-companion",
        showRetry: true,
      };
    case "protocol-mismatch":
      return {
        iconWarn: true,
        icon: "power",
        title: "Companion protocol mismatch",
        message:
          "This panel and your Companion speak different protocol versions. " +
          "Update the Companion, then retry.",
        hint: "dispatch-companion",
        showRetry: true,
      };
    case "mint-unavailable":
      return {
        iconWarn: true,
        icon: "terminal",
        title: "Couldn't start a session",
        message:
          "dispatch couldn't issue a connection token for the Companion. This " +
          "is usually a temporary backend hiccup — retry in a moment.",
        hint: "POST /api/companion/sessions",
        showRetry: true,
      };
    case "degraded":
      // The seam reached its defined fallback state (the stub resolves here).
      return {
        iconWarn: false,
        icon: "terminal",
        title: "Running in fallback mode",
        message:
          "The local Companion isn't available, so this panel is in its " +
          "server-side fallback mode. Interactive Claude Code is unavailable here.",
        hint: "Companion fallback — coming with Phase 2",
        showRetry: false,
      };
    case "not-detected":
    case "idle":
    default:
      // Visual spec §3 state (b) — Companion installed but offline (recoverable).
      return {
        iconWarn: true,
        icon: "power",
        title: "Companion isn't running",
        message:
          "The Companion is a small helper that runs on your Mac. It lets this " +
          "panel open your own local Claude Code — dispatch never holds a Claude " +
          "login. Start it, then retry.",
        hint: "dispatch-companion",
        showRetry: true,
      };
  }
}

function TermFailure({
  state,
  onRetry,
}: {
  state: ConnectionState;
  onRetry: () => void;
}) {
  const content = failureContent(state);
  const IconCmp = content.icon === "power" ? Ic.power : Ic.terminal;

  return (
    <div className="term-fail">
      <span className={content.iconWarn ? "ic warn" : "ic"}>
        <IconCmp />
      </span>
      <div className="ttl">{content.title}</div>
      <div className="msg">{content.message}</div>
      <div className="hint">{content.hint}</div>
      {content.showRetry && (
        <button className="btn-outline act" onClick={onRetry}>
          Retry connection
        </button>
      )}
    </div>
  );
}
