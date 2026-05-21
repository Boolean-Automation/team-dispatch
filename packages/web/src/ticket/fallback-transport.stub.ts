// dispatch — fallback-transport.stub: the Phase-1 degradation-seam proof.
//
// This is a TRIVIAL no-op `TerminalTransport`. It exists ONLY to prove the
// seam: `PanelTerminal` / `useCompanion` accept this stub WITHOUT modification,
// which proves Phase 2 can swap in a real server-side fallback transport by
// replacing THIS ONE FILE and touching nothing else in the component.
//
// It is NOT a fallback engine. There is no Agent SDK, no Anthropic Console
// org, no server-side model call here. `connect()` is a defined no-op that
// resolves immediately to a `degraded` state; `send()` throws — there is no
// engine behind it yet.
//
// Phase 2 replaces this file with the real server-side fallback transport.

import type {
  TerminalTransport,
  TransportHandlers,
} from "./terminal-transport.js";
import type { ClientFrame } from "./companion-protocol.js";

/**
 * The no-op stub fallback transport. Implements `TerminalTransport` exactly so
 * the type system — and `PanelTerminal` — accept it interchangeably with the
 * real `companion-ws-transport`.
 */
export class FallbackTransportStub implements TerminalTransport {
  private handlers: TransportHandlers | undefined;

  connect(handlers: TransportHandlers): void {
    this.handlers = handlers;
    // A defined no-op: resolve immediately to the `degraded` state. The panel
    // renders a defined fallback UI for `degraded` — the failure path routes
    // INTO the seam, not into a dead end.
    this.handlers.onStatus({
      state: "degraded",
      detail: "Phase 2 server-side fallback transport — not built in the spike.",
    });
  }

  send(_frame: ClientFrame): void {
    // No engine behind the stub. A real fallback transport would forward this.
    throw new Error("Phase 2 server-side fallback — not built in the spike.");
  }

  resize(_cols: number, _rows: number): void {
    // No-op — the stub has no live session to resize.
  }

  close(): void {
    this.handlers = undefined;
  }
}
