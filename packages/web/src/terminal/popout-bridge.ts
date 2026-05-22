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

/**
 * P2-5 fix (gate-review.md): the popout `Set<Window>` is decremented on
 * `beforeunload`, but some OS-level kills (force-quit, browser crash) skip
 * `beforeunload` and leave the set at size 1 — permanently blocking new
 * popouts until the opener tab also closes. Poll `popout.closed` every
 * 500ms in the opener as a backstop.
 */
const POPOUT_CLOSED_POLL_MS = 500;

let _popouts: Set<Window> = new Set();
let _channels = new Map<string, BroadcastChannel>();
/**
 * P2-5: registered per-popout cleanup callbacks. Keyed by Window so the poll
 * loop can dispatch the cleanup once `popout.closed` flips to true.
 */
let _popoutCleanups = new Map<Window, () => void>();
let _pollTimer: ReturnType<typeof setInterval> | null = null;

/** P2-5: start the polling loop on first popout open; idempotent. */
function ensurePollRunning(): void {
  if (_pollTimer !== null) return;
  _pollTimer = setInterval(() => {
    if (_popouts.size === 0) {
      // No popouts left — stop polling to avoid the background tick.
      if (_pollTimer !== null) {
        clearInterval(_pollTimer);
        _pollTimer = null;
      }
      return;
    }
    // Snapshot the set to detect closures without mutating during iteration.
    const snapshot = Array.from(_popouts);
    for (const win of snapshot) {
      let isClosed = false;
      try {
        isClosed = win.closed === true;
      } catch {
        // Cross-origin or detached popouts may throw on `.closed` — treat
        // any throw as "closed" since we can't track it anymore anyway.
        isClosed = true;
      }
      if (isClosed) {
        const cleanup = _popoutCleanups.get(win);
        _popoutCleanups.delete(win);
        _popouts.delete(win);
        try {
          cleanup?.();
        } catch {
          /* cleanup error must not break the polling loop */
        }
      }
    }
  }, POPOUT_CLOSED_POLL_MS);
  // unref the timer where supported so the loop doesn't keep a test process
  // alive after the panel closes. Browser windows don't expose `unref` —
  // `setInterval`'s return type in DOM is a `number`, so we can't call it
  // unconditionally; gracefully no-op when unavailable.
  const t = _pollTimer as unknown as { unref?: () => void };
  t.unref?.();
}

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

    // P2-5 fix (gate-review.md): unified cleanup function that runs on
    // EITHER `beforeunload` OR the 500ms `popout.closed` poll. OS-level
    // kills (force-quit, browser crash) skip beforeunload, so the poll is
    // the backstop that keeps the popout set + cap-enforcement honest.
    const cleanup = (): void => {
      _popouts.delete(win);
      _popoutCleanups.delete(win);
      try {
        win.removeEventListener("beforeunload", onUnload);
      } catch {
        /* already closed */
      }
    };
    _popoutCleanups.set(win, cleanup);

    const onUnload = (): void => {
      cleanup();
    };

    try {
      win.addEventListener("beforeunload", onUnload);
    } catch {
      // Cross-origin or already-closed popouts cannot install listeners; rely
      // on the 500ms poll below to detect death.
    }

    // P2-5: start the poll loop (idempotent — does nothing if already running).
    ensurePollRunning();

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
  _popoutCleanups = new Map();
  if (_pollTimer !== null) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

/**
 * P2-5 test-only: synchronously run one poll iteration. Vitest's fake-timers
 * could also drive the live setInterval, but exposing this seam keeps the
 * test (a) deterministic and (b) free from setting up fake timers globally.
 */
export function __pollPopoutClosedForTest(): void {
  if (_popouts.size === 0) return;
  const snapshot = Array.from(_popouts);
  for (const win of snapshot) {
    let isClosed = false;
    try {
      isClosed = win.closed === true;
    } catch {
      isClosed = true;
    }
    if (isClosed) {
      const cleanup = _popoutCleanups.get(win);
      _popoutCleanups.delete(win);
      _popouts.delete(win);
      try {
        cleanup?.();
      } catch {
        /* */
      }
    }
  }
}
