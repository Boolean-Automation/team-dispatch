// dispatch — popout-bridge (Phase 2 / Slice 3).
//
// The singleton that hoists `TerminalSubscribeTransport` onto the opener's
// `window.terminalTransport`. The popout route reads the singleton via
// `window.opener.terminalTransport` (after a try/catched same-origin assertion
// per Codex R2-F4) — no new WS, no token re-mint.
//
// Cap=1 per the Codex F4 binding: only one popout may exist at a time across
// the opener window. The cap is opener-side state — when the popout window
// closes (beforeunload), the set decrements and the cap re-opens.
//
// Cross-window ephemeral settings sync rides a BroadcastChannel keyed by
// `dispatch-terminal-<ticket_id>`. Theme/font-size changes published in either
// window land on the listener registered in the other.

import type {
  TerminalSubscribeTransport,
  TerminalSendTransport,
} from "./transport-contract.js";

/** A facade over BroadcastChannel so tests can swap implementations. */
export interface SettingsChannel {
  postMessage(payload: unknown): void;
  onMessage(handler: (payload: unknown) => void): () => void;
  close(): void;
}

/** What the bridge exposes to the toolbar + popout boot code. */
export interface PopoutBridge {
  /** Open a popout window for (ticket, pty). Returns false if the cap is full. */
  openPopout(opts: {
    ticketId: string;
    ptyId: string;
    url?: string;
  }): boolean;
  /** True iff a popout already exists. */
  isCapReached(): boolean;
  /** Read-only view of live popout windows. */
  readonly popouts: ReadonlySet<Window>;
  /** Get (or create) the per-ticket settings BroadcastChannel. */
  settingsChannel(ticketId: string): SettingsChannel;
  /** Whether the opener (this window) is closed — queried by the popout. */
  getOpenerClosed(): boolean;
}

/** The window-global key the bridge installs the transport under. */
const TRANSPORT_GLOBAL_KEY = "terminalTransport";

/** The single popout cap — Codex F4 binding. */
const POPOUT_CAP = 1;

let _popouts: Set<Window> = new Set();
let _channels = new Map<string, BroadcastChannel>();

/**
 * Install the transport singleton on `window`. Called once on first
 * TerminalPanel mount; subsequent calls overwrite (e.g. on transport rebuild
 * after a Companion restart).
 */
export function installTerminalTransportOnWindow(
  transport: TerminalSubscribeTransport & Partial<TerminalSendTransport>
): void {
  (window as unknown as Record<string, unknown>)[TRANSPORT_GLOBAL_KEY] =
    transport;
}

/** Lookup helper — returns the installed transport, if any. */
export function getInstalledTerminalTransport():
  | (TerminalSubscribeTransport & Partial<TerminalSendTransport>)
  | undefined {
  return (window as unknown as Record<string, unknown>)[
    TRANSPORT_GLOBAL_KEY
  ] as (TerminalSubscribeTransport & Partial<TerminalSendTransport>) | undefined;
}

/** Build the BroadcastChannel-backed settings channel for a ticket. */
function makeSettingsChannel(ticketId: string): SettingsChannel {
  const name = `dispatch-terminal-${ticketId}`;
  // Reuse a single BroadcastChannel per name so multiple subscribers in the
  // same window share one channel — the runtime BroadcastChannel API rejects
  // posting to your own channel by design, so this also avoids self-echo.
  let bc = _channels.get(name);
  if (!bc) {
    bc = new BroadcastChannel(name);
    _channels.set(name, bc);
  }
  const handlers = new Set<(payload: unknown) => void>();
  const wrapped = (ev: MessageEvent) => {
    for (const h of handlers) {
      try {
        h(ev.data);
      } catch {
        /* handler error must not break the channel */
      }
    }
  };
  bc.addEventListener("message", wrapped);

  return {
    postMessage(payload: unknown) {
      try {
        bc?.postMessage(payload);
      } catch {
        /* channel closed */
      }
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    close() {
      bc?.removeEventListener("message", wrapped);
      handlers.clear();
      // Don't close the underlying BC here — other subscribers may share it.
    },
  };
}

const bridge: PopoutBridge = {
  openPopout({ ticketId, ptyId, url }): boolean {
    if (_popouts.size >= POPOUT_CAP) return false;
    const target =
      url ??
      `/terminal-popout?ticket=${encodeURIComponent(
        ticketId
      )}&pty=${encodeURIComponent(ptyId)}`;
    const win = window.open(target, "_blank", "popup,width=900,height=600");
    if (!win) return false;
    _popouts.add(win);
    const onUnload = () => {
      _popouts.delete(win);
      try {
        win.removeEventListener("beforeunload", onUnload);
      } catch {
        /* already closed */
      }
    };
    try {
      win.addEventListener("beforeunload", onUnload);
    } catch {
      // Cross-origin or already-closed popouts cannot install listeners; rely
      // on the periodic poll in the popout-route to detect death from inside.
    }
    return true;
  },

  isCapReached(): boolean {
    return _popouts.size >= POPOUT_CAP;
  },

  get popouts(): ReadonlySet<Window> {
    return _popouts;
  },

  settingsChannel(ticketId: string): SettingsChannel {
    return makeSettingsChannel(ticketId);
  },

  getOpenerClosed(): boolean {
    // The opener-side bridge never reports itself as closed.
    return false;
  },
};

/** Singleton accessor. The bridge is a module-level singleton per window. */
export function getPopoutBridge(): PopoutBridge {
  return bridge;
}

/**
 * Test-only reset hook. Vitest's `beforeEach` resets the popout set + channel
 * map so each test starts with a clean slate. Production code never calls this.
 */
export function resetPopoutBridgeForTest(): void {
  for (const bc of _channels.values()) {
    try {
      bc.close();
    } catch {
      /* already closed */
    }
  }
  _popouts = new Set();
  _channels = new Map();
}
