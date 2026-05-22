// dispatch — fallback-transport.stub: the Phase-1 degradation-seam proof.
//
// This is a TRIVIAL no-op `TerminalTransport`. It exists ONLY to prove the
// seam: components that depend on `TerminalTransport` accept this stub
// WITHOUT modification, which proves Phase 2 can swap in a real server-side
// fallback transport by replacing THIS ONE FILE and touching nothing else.
//
// It is NOT a fallback engine. There is no Agent SDK, no Anthropic Console
// org, no server-side model call here. `connect()` is a defined no-op that
// resolves immediately to a `degraded` state; `send()` throws — there is no
// engine behind it yet.

import type {
  TerminalTransport,
  TransportHandlers,
  PtyFrame,
} from "./terminal-transport.js";
import type { ClientFrame } from "./companion-protocol.js";

export class FallbackTransportStub implements TerminalTransport {
  private handlers: TransportHandlers | undefined;

  connect(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.handlers.onStatus({
      state: "degraded",
      detail: "Phase 2 server-side fallback transport — not built in the spike.",
    });
  }

  send(_frame: ClientFrame): void {
    throw new Error("Phase 2 server-side fallback — not built in the spike.");
  }

  openPty(_ticketId: string): Promise<string> {
    return Promise.reject(
      new Error("Phase 2 server-side fallback — not built in the spike.")
    );
  }

  subscribe(_pty_id: string, _listener: (f: PtyFrame) => void): () => void {
    return () => {};
  }

  write(_pty_id: string, _data: string): void {
    /* no-op */
  }

  resize(_pty_id: string, _cols: number, _rows: number): void {
    /* no-op */
  }

  closePty(_pty_id: string): void {
    /* no-op */
  }

  close(): void {
    this.handlers = undefined;
  }
}
