// dispatch — TerminalPanel (Phase 2 / Slice 3).
//
// The bottom-slide-up / dock-right panel host. State machine per visual spec
// §9:  closed → bottom-open (default) ↔ dock-right-open ↔ popout-open.
//
// What this component owns:
//   - The dock chrome — toolbar (`.term-bar`), tab pill, action cluster,
//     stage wrapper, drag-resize splitter.
//   - The position state machine (via `usePanelState`).
//   - Drag-resize bindings (via `useDragResize`).
//   - Find overlay show/hide (Cmd/Ctrl+F).
//   - Popout opening — singleton transport hoisted to window via
//     `installTerminalTransportOnWindow`; popout reads via window.opener.
//   - Lifecycle: on ticket-route unmount, sends pty.close and tears down.
//
// What this component does NOT own:
//   - xterm.js lifecycle — that's `<Terminal>` from S2.
//   - WebSocket lifecycle / handshake — that's `CompanionWsTransport`.
//   - The launcher (S4 fills the empty `.term-launch` slot — the bar
//     already reserves space for it but S3 only renders a placeholder).

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Terminal, type TerminalHandle } from "./Terminal.js";
import { FindOverlay } from "./find-overlay.js";
import { LauncherButton } from "./launcher-button.js";
import { TabStrip } from "./tab-strip.js";
import { useActivePty } from "./use-active-pty.js";
import { useDragResize } from "./use-drag-resize.js";
import { usePanelState } from "./use-panel-state.js";
import {
  installTerminalTransportOnWindow,
  getPopoutBridge,
} from "./popout-bridge.js";
import { useCompanion } from "../ticket/use-companion-session.js";
import type { ConnectionState } from "../ticket/terminal-transport.js";
import type { TerminalTransport } from "../ticket/terminal-transport.js";
import Ic from "../shell/Ic.js";
import {
  useTerminalSettings,
  type ClerkLikeUser,
} from "../settings/use-terminal-settings.js";
import { useUser } from "@clerk/clerk-react";

export interface TerminalPanelProps {
  /** The ticket's display id (`DSP-2841`) — scopes the panel + PTY. */
  ticketId: string;
  /**
   * Optional pre-built transport — tests inject a fake; production lets the
   * hook construct the real `CompanionWsTransport`.
   */
  transport?: TerminalTransport;
  /** Optional initial position override (defaults to localStorage / bottom). */
  initialPosition?: "bottom" | "right";
}

const LIVE_STATES: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  "connecting",
  "connected",
]);

export function TerminalPanel({
  ticketId,
  transport: injectedTransport,
  initialPosition,
}: TerminalPanelProps): React.ReactElement | null {
  // S5 — read terminal settings (theme/font/scrollback/position) from Clerk
  // publicMetadata via the single-source-of-truth hook. The hook returns
  // defaults when no user is signed in / no provider is mounted.
  const safeUser = useSafeClerkLikeUser();
  const { settings: terminalSettings, save: saveTerminalSettings } =
    useTerminalSettings({ user: safeUser });

  const panel = usePanelState({
    initialPosition,
    syncedPosition: terminalSettings.position,
    persistPosition: (next) => {
      void saveTerminalSettings({ position: next });
    },
  });
  const companion = useCompanion({
    ticketId,
    transport: injectedTransport,
    meta: undefined,
  });
  const { status, transport } = companion;
  // S6 — the panel's single source of truth for the rendered PTY is the
  // multi-PTY data-model hook. useCompanion still triggers the initial
  // pty.open on `connected` (its onPty promise resolves the same pty_id);
  // useActivePty observes the resulting `pty.opened` frame and owns the
  // recency stack. v1 renders only the active pointer; v1.5 will iterate
  // the full list.
  const activePty = useActivePty(ticketId, transport, companion.onFrame);
  const activePtyId = activePty.activePtyId;
  const [findOpen, setFindOpen] = useState(false);
  const [popoutOpen, setPopoutOpen] = useState(false);
  const termRef = useRef<TerminalHandle | null>(null);

  const isLive = LIVE_STATES.has(status.state) && activePtyId !== null;

  // S6 — once the panel has observed at least one live PTY (via useCompanion's
  // connect-driven open), the user owns the "is there a PTY" question. If
  // they close the last shell, we DO NOT silently re-open — they see the
  // "Open a shell" placeholder and click `activePty.openPty()`. This avoids
  // the startup-race double-mint where both useCompanion's openPty AND a
  // panel-level auto-open would fire against the same connected state.
  // The explicit-click path is wired into the .term-fail placeholder below.

  // Hoist the transport onto window so the popout window can read it via
  // window.opener.terminalTransport. Update whenever the transport rebuilds
  // (retry, ticket change).
  useEffect(() => {
    if (transport) {
      installTerminalTransportOnWindow(
        transport as unknown as Parameters<
          typeof installTerminalTransportOnWindow
        >[0]
      );
    }
  }, [transport]);

  // Cmd/Ctrl+F → toggle find overlay (only when panel is open).
  useEffect(() => {
    if (!panel.state.open) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "f" && (ev.metaKey || ev.ctrlKey) && !ev.shiftKey) {
        ev.preventDefault();
        setFindOpen((v) => !v);
      } else if (ev.key === "Escape" && findOpen) {
        setFindOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel.state.open, findOpen]);

  // Drag-resize — bottom (ns) or right (ew) per position.
  const onFit = useCallback(() => {
    termRef.current?.fit();
    if (activePtyId && termRef.current?.term) {
      try {
        transport.resize(
          activePtyId,
          termRef.current.term.cols,
          termRef.current.term.rows
        );
      } catch {
        /* host detached */
      }
    }
  }, [activePtyId, transport]);

  const isBottom = panel.state.position === "bottom";
  const drag = useDragResize({
    axis: isBottom ? "ns" : "ew",
    initial: isBottom ? 320 : 420,
    min: isBottom ? 140 : 320,
    max: isBottom ? Math.round(window.innerHeight * 0.7) : 720,
    onFit,
  });

  // Popout opening — Codex F4 binding (cap=1, opener-close lock).
  const onPopout = useCallback(() => {
    if (!activePtyId) return;
    if (popoutOpen) return;
    const bridge = getPopoutBridge();
    const ok = bridge.openPopout({ ticketId, ptyId: activePtyId });
    if (ok) {
      setPopoutOpen(true);
      panel.setPoppedOut(true);
      // When the popout window closes, the bridge's beforeunload listener
      // removes it from the set — we re-check on focus to flip our state.
      const recheck = () => {
        if (!bridge.isCapReached()) {
          setPopoutOpen(false);
          panel.setPoppedOut(false);
          window.removeEventListener("focus", recheck);
        }
      };
      window.addEventListener("focus", recheck);
    }
  }, [activePtyId, popoutOpen, panel, ticketId]);

  // Ticket-route unmount: close the LATEST active PTY explicitly.
  // useCompanion already handles the WS close; this binding is a
  // belt-and-suspenders close frame.
  //
  // S6 — read the active id via a ref so the effect's cleanup fires ONCE on
  // actual unmount, not on every pointer flip. With the multi-PTY pointer in
  // place, depending on `activePtyId` here would close the old PTY each time
  // a new one became active — the exact "leak the data layer into the UI"
  // failure mode this slice exists to prevent.
  const latestActivePtyIdRef = useRef<string | null>(activePtyId);
  useEffect(() => {
    latestActivePtyIdRef.current = activePtyId;
  }, [activePtyId]);
  useEffect(() => {
    return () => {
      const pid = latestActivePtyIdRef.current;
      if (pid) {
        try {
          transport.send({ t: "pty.close", pty_id: pid });
        } catch {
          /* transport already closed */
        }
      }
    };
  }, [transport]);

  // Close button → close panel.
  const onClose = useCallback(() => {
    panel.close();
  }, [panel]);

  // Toggle between bottom and right (the spec calls this a Settings
  // preference; we expose a toolbar shortcut so the L1 evidence can flip it).
  const onTogglePosition = useCallback(() => {
    panel.togglePosition();
  }, [panel]);

  // Connection-dot class — emerald (connected), warn (connecting), off (else).
  const connDotClass = useMemo(() => {
    if (status.state === "connected") return "conn-dot";
    if (status.state === "connecting") return "conn-dot warn";
    return "conn-dot off";
  }, [status.state]);

  // S6 — dev-only debug helper exposed on window for L2 multi-PTY evidence.
  // Gated by import.meta.env.DEV so it disappears in prod builds. The
  // openExtraPty handle bypasses the launcher; closeActivePty drives the
  // useActivePty close path the same way a future close affordance would.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const helper = {
      openExtraPty(targetTicket: string = ticketId): void {
        transport.send({ t: "pty.open", ticket_id: targetTicket });
      },
      closeActivePty(): void {
        if (activePtyId) activePty.closePty(activePtyId);
      },
      get activePtyId(): string | null {
        return activePtyId;
      },
      get ptyList(): readonly string[] {
        return activePty.ptyList;
      },
    };
    (window as unknown as { __dispatchTerminal?: typeof helper }).__dispatchTerminal =
      helper;
    return () => {
      const w = window as unknown as { __dispatchTerminal?: unknown };
      if (w.__dispatchTerminal === helper) delete w.__dispatchTerminal;
    };
  }, [activePtyId, activePty, transport, ticketId]);

  if (!panel.state.open) return null;

  const panelClassName = isBottom ? "term-panel-bottom" : "term-panel-right";
  const panelStyle: React.CSSProperties = {
    ...drag.panelStyle,
  };

  return (
    <div
      className={`${panelClassName}${drag.dragging ? " is-resizing" : ""}`}
      style={panelStyle}
      role="region"
      aria-label="Terminal panel"
      data-testid="terminal-panel"
    >
      <div
        {...drag.splitterProps}
        role="separator"
        aria-orientation={isBottom ? "horizontal" : "vertical"}
        aria-label="Resize terminal"
        data-testid="terminal-splitter"
      />
      <div className="term-bar">
        {/* §3.1 launcher slot — S4 fills the empty slot scaffolded in S3.
            The button reads Clerk publicMetadata.terminalSettings.launcher
            (default {label:'Claude',command:'claude'}). Click writes
            `command + \r` bytes to the active PTY via transport.send and
            fire-and-forgets a SHA-256-hashed audit POST. */}
        <LauncherButton
          activePtyId={activePtyId}
          ticketDisplayId={ticketId}
          transport={transport}
        />
        {/* S6 — v1: single-render; v1.5: flip .term-tabs to interactive +
            render per pty_id. Active-PTY pointer already supports the flip. */}
        <TabStrip
          ticketId={ticketId}
          activePtyId={activePtyId}
          shellName="zsh"
          connDotClass={connDotClass}
        />
        <div className="term-acts">
          <button
            type="button"
            className="term-act"
            onClick={() => setFindOpen((v) => !v)}
            title="Find (Cmd/Ctrl+F)"
            aria-label="Find in terminal"
          >
            <Ic.search />
          </button>
          <button
            type="button"
            className="term-act"
            onClick={onTogglePosition}
            title={`Move to ${isBottom ? "right" : "bottom"}`}
            aria-label="Toggle panel position"
          >
            {isBottom ? <Ic.splitV /> : <Ic.splitH />}
          </button>
          <button
            type="button"
            className="term-act"
            onClick={onPopout}
            disabled={popoutOpen || !activePtyId}
            aria-disabled={popoutOpen || !activePtyId ? "true" : undefined}
            title={popoutOpen ? "Already popped out" : "Open in new window"}
            aria-label="Pop out terminal"
          >
            <Ic.popout />
          </button>
          <button
            type="button"
            className="term-act"
            onClick={onClose}
            title="Close terminal"
            aria-label="Close terminal"
          >
            ×
          </button>
        </div>
      </div>
      <div className="term-stage">
        {popoutOpen ? (
          <div className="term-detached">
            <Ic.popout />
            <div className="msg">
              Terminal is open in a separate window — bring it back to use it
              here.
            </div>
          </div>
        ) : isLive && activePtyId ? (
          <Terminal
            ref={termRef}
            ptyId={activePtyId}
            ticketId={ticketId}
            transport={transport}
            themeName={terminalSettings.theme}
            fontSize={terminalSettings.font.size}
            scrollback={terminalSettings.scrollbackLines}
          />
        ) : status.state === "connected" && activePtyId === null ? (
          // S6 — connected but no PTY (user closed their only shell, or the
          // auto-open hasn't landed yet). Offer an explicit "Open a shell"
          // affordance so the panel never lives in a dead state.
          <div className="term-fail" data-testid="terminal-open-shell">
            <span className="ic">
              <Ic.terminal />
            </span>
            <div className="ttl">No shell open</div>
            <div className="msg">
              Open a shell to start working in this ticket's terminal.
            </div>
            <button
              className="btn-outline act"
              onClick={() => activePty.openPty()}
            >
              Open a shell
            </button>
          </div>
        ) : (
          <TermFailure state={status.state} onRetry={companion.retry} />
        )}
        {findOpen && !popoutOpen && isLive && (
          <FindOverlay
            searchAddon={termRef.current?.searchAddon ?? null}
            onClose={() => setFindOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

// ── Failure-block render — salvaged from PanelTerminal `failureContent`. ────

interface FailureContent {
  iconWarn: boolean;
  icon: "terminal" | "power";
  title: string;
  message: string;
  hint: string;
  showRetry: boolean;
}

function failureContent(state: ConnectionState): FailureContent {
  switch (state) {
    case "shell-unavailable":
    case "claude-unusable":
    case "local-permission-denied":
      return {
        iconWarn: true,
        icon: "terminal",
        title: "Couldn't open a shell",
        message:
          "The Companion connected but couldn't start your login shell. Check that your shell ($SHELL) is set correctly and you have permission to run it.",
        hint: "echo $SHELL",
        showRetry: true,
      };
    case "quota-limited":
      return {
        iconWarn: true,
        icon: "terminal",
        title: "Rate-limited",
        message:
          "Your shell session hit a rate limit. Wait a moment, then retry.",
        hint: "dispatch-companion",
        showRetry: true,
      };
    case "version-mismatch":
    case "protocol-mismatch":
      return {
        iconWarn: true,
        icon: "power",
        title: "Companion is out of date",
        message:
          "The Companion on your Mac is a different version than this panel expects. Update the Companion, then retry.",
        hint: "dispatch-companion",
        showRetry: true,
      };
    case "mint-unavailable":
      return {
        iconWarn: true,
        icon: "terminal",
        title: "Couldn't start a session",
        message:
          "dispatch couldn't issue a connection token for the Companion — usually a brief backend hiccup. Retry in a moment.",
        hint: "POST /api/companion/sessions",
        showRetry: true,
      };
    case "degraded":
      return {
        iconWarn: false,
        icon: "terminal",
        title: "Running in fallback mode",
        message:
          "The local Companion isn't available, so this panel is in its server-side fallback mode.",
        hint: "Companion fallback — coming with Phase 2",
        showRetry: false,
      };
    case "not-detected":
    case "idle":
    default:
      return {
        iconWarn: true,
        icon: "power",
        title: "Companion isn't running",
        message:
          "The Companion is a small helper that runs on your Mac. It opens a real terminal here, on your own machine — dispatch never runs anything remotely. Start it, then retry.",
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
}): React.ReactElement {
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

// ── Safe Clerk wrapper ───────────────────────────────────────────────────────
//
// Same pattern as the Settings page: call useUser() inside a try/catch so the
// panel mounts cleanly in tests / pre-Clerk-setup dev. Returns a Clerk-like
// user adapter (or null) for useTerminalSettings to consume.

interface ClerkRawUser {
  id: string;
  publicMetadata: Record<string, unknown>;
  reload: () => Promise<unknown>;
  update: (patch: {
    publicMetadata: Record<string, unknown>;
  }) => Promise<unknown>;
}

function useSafeClerkLikeUser(): ClerkLikeUser | null {
  let raw: ClerkRawUser | null = null;
  try {
    const result = useUser();
    raw = (result.user ?? null) as ClerkRawUser | null;
  } catch {
    raw = null;
  }
  if (!raw) return null;
  const captured: ClerkRawUser = raw;
  return {
    id: captured.id,
    get publicMetadata() {
      return captured.publicMetadata;
    },
    reload: async () => {
      await captured.reload();
    },
    update: async (patch) => {
      await captured.update(patch);
    },
  };
}
