// dispatch — TerminalSubscribeTransport contract (Phase 2 / Slice 2).
//
// The Terminal component (S2) subscribes to PTY frames keyed by `pty_id` and
// writes bytes back. This is a NARROWER contract than the full
// `TerminalTransport` interface in `../ticket/terminal-transport.ts` —
//   - the Slice 1 Companion now sends per-PTY frames (`pty.data` / `pty.exit`),
//   - Slice 3 will hoist a singleton implementation onto `window.terminalTransport`
//     and wire it to the WS,
//   - Slice 2 is the consumer-only contract: subscribe + write, nothing else.
//
// Decoupling here lets the Terminal component be tested in isolation against a
// mock transport, and lets the popout (S3) reuse the same hook against the
// opener's transport via `window.opener.terminalTransport`.

/** A single frame the transport pushes to a subscriber. */
export type TerminalFrame =
  | {
      kind: "pty.data";
      pty_id: string;
      /** UTF-8 bytes of the PTY stdout/stderr — what xterm.write accepts. */
      bytes: Uint8Array;
    }
  | {
      kind: "pty.exit";
      pty_id: string;
      code: number;
      signal: string | null;
    };

/** A subscriber callback. Receives every frame for the (pty_id) it subscribed for. */
export type TerminalFrameSubscriber = (frame: TerminalFrame) => void;

/**
 * The narrow consumer contract S2 depends on. Slice 3 implements this against
 * the Phase 1 `CompanionWsTransport` and hangs it on `window.terminalTransport`
 * so popout windows can subscribe via `window.opener.terminalTransport`.
 */
export interface TerminalSubscribeTransport {
  /**
   * Subscribe to frames for `pty_id`. Returns an unsubscribe fn.
   *
   * Implementations: filter the WS frame stream by `pty_id` and invoke the
   * subscriber for every matching frame.
   */
  subscribe(pty_id: string, subscriber: TerminalFrameSubscriber): () => void;

  /**
   * Write bytes (UTF-8 text) into `pty_id`. Used by:
   *   - xterm onData → keystrokes → shell stdin
   *   - the Cmd/Ctrl+V paste handler
   *   - the Cmd/Ctrl+C without selection (SIGINT byte)
   */
  write(pty_id: string, data: string): void;
}

/**
 * The send-side of the Phase 2 multi-PTY contract. Slice 3 implements this on
 * the singleton transport so the TerminalPanel can issue pty.open / pty.close
 * / pty.resize frames without reaching into the WS guts.
 */
export interface TerminalSendTransport {
  /** Open a new PTY for the given ticket. Returns the server-minted pty_id. */
  openPty(ticketId: string): Promise<string>;
  /** Close a PTY (and the panel-side subscription). */
  closePty(pty_id: string): void;
  /** Resize a PTY. */
  resizePty(pty_id: string, cols: number, rows: number): void;
}
