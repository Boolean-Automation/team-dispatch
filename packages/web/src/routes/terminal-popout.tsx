// dispatch — popout route (Phase 2 / Slice 3).
//
// The popout window. Renders a second `<Terminal>` against the opener's
// singleton transport — same xterm + same scrollback + zero new WebSockets.
//
// Codex F4 binding — opener-close detection within 500ms:
//   - First useEffect line: try/catched same-origin assertion.
//   - 200ms-interval poll on `window.opener?.closed`. On detection: lock the
//     xterm (disable input + freeze scrollback) and replace toolbar with a
//     "Main dispatch window closed" banner + "Close popout" button. NO
//     re-handshake, NO token re-mint.
//
// The popout does NOT mount the panel chrome (toolbar with `+` / popout /
// close) — it is its own standalone window. It mounts just the Terminal
// component + the find overlay + a minimal status banner.

import React, { useEffect, useRef, useState } from "react";
import { Terminal, type TerminalHandle } from "../terminal/Terminal.js";
import { FindOverlay } from "../terminal/find-overlay.js";
import type {
  TerminalSubscribeTransport,
  TerminalSendTransport,
} from "../terminal/transport-contract.js";
import Ic from "../shell/Ic.js";

type PopoutState = "loading" | "live" | "detached" | "opener-closed";

/**
 * The popout route — mounted at `/terminal-popout?ticket=DSP-...&pty=...`.
 * Lives outside the auth-gated app shell (no Rail, no Topbar).
 */
export function TerminalPopoutRoute(): React.ReactElement {
  const [state, setState] = useState<PopoutState>("loading");
  const [findOpen, setFindOpen] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [transport, setTransport] = useState<
    | (TerminalSubscribeTransport & Partial<TerminalSendTransport>)
    | null
  >(null);
  const termRef = useRef<TerminalHandle | null>(null);

  useEffect(() => {
    // ── Codex R2-F4: same-origin assertion (try/catch — cross-origin throws) ─
    let openerOrigin: string | null = null;
    try {
      openerOrigin = window.opener?.location?.origin ?? null;
    } catch {
      /* cross-origin throw — fall through to detached */
    }
    if (!openerOrigin || openerOrigin !== window.location.origin) {
      setState("detached");
      return;
    }

    // Parse query params for the (ticket, pty) tuple.
    const params = new URLSearchParams(window.location.search);
    const ticket = params.get("ticket");
    const pty = params.get("pty");
    if (!ticket || !pty) {
      setState("detached");
      return;
    }
    setTicketId(ticket);
    setPtyId(pty);

    // Reach into the opener's terminalTransport singleton (PROVEN — prototype
    // probe 2). No new WS, no token mint.
    const openerTransport = (window.opener as unknown as {
      terminalTransport?: TerminalSubscribeTransport & Partial<TerminalSendTransport>;
    })?.terminalTransport;
    if (!openerTransport) {
      setState("detached");
      return;
    }
    setTransport(openerTransport);
    setState("live");

    // ── Opener-close poll (Codex F4 binding — within 500ms) ──────────────
    // Detect both `window.opener.closed === true` AND `window.opener === null`
    // (some browsers null out the opener reference immediately on close).
    const poll = setInterval(() => {
      try {
        if (!window.opener || window.opener.closed) {
          setState("opener-closed");
          clearInterval(poll);
        }
      } catch {
        // Cross-origin can throw on the .closed check too — be defensive.
        setState("opener-closed");
        clearInterval(poll);
      }
    }, 200);

    return () => clearInterval(poll);
  }, []);

  // Cmd/Ctrl+F → find overlay.
  useEffect(() => {
    if (state !== "live") return;
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
  }, [state, findOpen]);

  // When the opener closes, lock the xterm input (disable onData → write).
  // xterm.js exposes `.options.disableStdin = true` to refuse input bytes.
  useEffect(() => {
    if (state !== "opener-closed") return;
    const t = termRef.current?.term;
    if (t) {
      try {
        // Disable stdin so keystrokes don't bounce into a dead transport.
        (t.options as unknown as { disableStdin?: boolean }).disableStdin = true;
        // Blur focus so the cursor doesn't pretend to be live.
        t.blur();
      } catch {
        /* terminal already disposed */
      }
    }
  }, [state]);

  if (state === "loading") {
    return (
      <div className="term-popout-body">
        <div className="term-stage">
          <div className="term-detached">
            <div className="msg">Connecting to dispatch window…</div>
          </div>
        </div>
      </div>
    );
  }

  if (state === "detached") {
    return (
      <div className="term-popout-body">
        <div className="term-stage">
          <div className="term-detached">
            <Ic.popout />
            <div className="msg">
              This popout can't reach its dispatch window. Reopen the popout
              from dispatch to start a new session.
            </div>
            <button
              className="btn-outline"
              onClick={() => window.close()}
            >
              Close popout
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="term-popout-body">
      {state === "opener-closed" ? (
        <div className="term-popout-banner">
          <span className="msg">
            Main dispatch window closed. Reopen from dispatch to resume this
            terminal.
          </span>
          <button
            className="close"
            onClick={() => window.close()}
          >
            Close popout
          </button>
        </div>
      ) : (
        <div className="term-bar">
          <div className="term-tabs">
            <div className="term-tab-pill" title={`${ticketId} · popout`}>
              <span className="conn-dot" aria-hidden="true" />
              <span>{ticketId} · popout</span>
            </div>
          </div>
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
              onClick={() => window.close()}
              title="Close popout"
              aria-label="Close popout"
            >
              ×
            </button>
          </div>
        </div>
      )}
      <div className="term-stage">
        {transport && ticketId && ptyId && (
          <Terminal
            ref={termRef}
            ptyId={ptyId}
            ticketId={ticketId}
            transport={transport}
          />
        )}
        {findOpen && state === "live" && (
          <FindOverlay
            searchAddon={termRef.current?.searchAddon ?? null}
            onClose={() => setFindOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
