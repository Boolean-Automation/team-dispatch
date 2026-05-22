// dispatch — companion-ws-transport: the Phase 2 multi-PTY Companion transport.
//
// One WebSocket per browser window. Each WS may own zero-or-more PTYs keyed by
// a server-minted ULID. The transport:
//   1. mints a scoped connection token via POST /api/companion/sessions,
//   2. probes GET http://127.0.0.1:<port>/healthz,
//   3. opens the loopback WebSocket and waits for a `hello` frame,
//   4. validates the protocolVersion + intersects capabilities,
//   5. tracks `companion_started_at`; a new epoch on reconnect invalidates
//      cached pty_ids (Phase 2 no-resume — clients spawn fresh `pty.open`).
//
// The Terminal component never sees any of this — it depends only on the
// `TerminalTransport` interface (the seam) + the narrower
// `TerminalSubscribeTransport` it consumes via `terminal/index.ts`.

import type {
  TerminalTransport,
  TransportHandlers,
  TransportStatus,
  ConnectionState,
  PtyFrame,
} from "./terminal-transport.js";
import {
  parseServerFrame,
  isProtocolCompatible,
  intersectCapabilities,
  CLIENT_CAPABILITIES,
  type ClientFrame,
  type ServerFrame,
} from "./companion-protocol.js";
import { apiClient } from "../lib/api-client.js";
import { fireInfoToast } from "../lib/use-undoable-mutation.js";

/** Default fixed loopback port the Companion listens on. */
const DEFAULT_COMPANION_PORT = 7720;

/** Handshake-timeout guard (visual spec §7.1 — Companion isn't running). */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Token-mint contract — injected so tests need no live api. */
export interface CompanionTokenResponse {
  token: string;
  sessionId: string;
  port: number;
}

export type MintTokenFn = (
  ticketId: string,
  origin: string
) => Promise<CompanionTokenResponse>;

export type HealthProbeFn = (port: number) => Promise<boolean>;

export type SocketFactory = (url: string) => WebSocket;

/** Optional ticket metadata for the context-injection preamble. */
export interface CompanionSessionMeta {
  status?: string;
  clientSlug?: string;
  title?: string;
}

export interface CompanionWsTransportOptions {
  ticketId: string;
  origin: string;
  meta?: CompanionSessionMeta;
  mintToken?: MintTokenFn;
  healthProbe?: HealthProbeFn;
  socketFactory?: SocketFactory;
  handshakeTimeoutMs?: number;
}

function defaultMintToken(
  ticketId: string,
  origin: string
): Promise<CompanionTokenResponse> {
  return apiClient.post<CompanionTokenResponse>("/api/companion/sessions", {
    ticketId,
    origin,
  });
}

async function defaultHealthProbe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: "GET",
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Internal record of a pending pty.open resolution. */
interface PendingOpen {
  ticketId: string;
  resolve: (pty_id: string) => void;
  reject: (err: Error) => void;
}

/**
 * P1-2 fix: monotonic counter for request_id minting. ULID would also work but
 * a counter keeps the WS frames a few bytes smaller per open and the values
 * scoped to this transport are guaranteed-unique. Reset on each transport
 * (one per panel session) — no cross-transport collision risk.
 */
let _nextRequestId = 0;
function mintRequestId(): string {
  _nextRequestId = (_nextRequestId + 1) >>> 0;
  return `req-${_nextRequestId}`;
}

/** Map.values().next() — typed helper for first-insert-order entry. */
function firstPending(m: Map<string, PendingOpen>): PendingOpen | null {
  const it = m.values().next();
  return it.done ? null : it.value;
}

/** Delete the first-insert-order key from a Map. */
function deleteFirst(m: Map<string, PendingOpen>): void {
  const it = m.keys().next();
  if (!it.done) m.delete(it.value);
}

/**
 * The real Companion WebSocket transport. One per panel session.
 */
export class CompanionWsTransport implements TerminalTransport {
  private readonly opts: Required<
    Pick<CompanionWsTransportOptions, "ticketId" | "origin">
  > & {
    meta: CompanionSessionMeta;
    mintToken: MintTokenFn;
    healthProbe: HealthProbeFn;
    socketFactory: SocketFactory;
    handshakeTimeoutMs: number;
  };

  private ws: WebSocket | undefined;
  private handlers: TransportHandlers | undefined;
  private closed = false;
  private handshakeComplete = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Latest known companion epoch — bumped triggers cache invalidation. */
  private companionStartedAt: number | undefined;
  /** Intersected capabilities surfaced via status. */
  private capabilities: string[] = [];

  /** Per-pty subscribers, keyed by pty_id. */
  private subscribers = new Map<string, Set<(f: PtyFrame) => void>>();
  /**
   * P1-2 fix (gate-review.md): pending pty.open awaiters, keyed by the
   * client-minted `request_id` that was sent on the open frame. The map shape
   * (vs. the previous FIFO array) is load-bearing — a `pty.error` for a
   * specific request_id rejects ONLY that pending promise, leaving any other
   * concurrent opens untouched. The previous FIFO `cap-exceeded` shift
   * rejected the wrong pending when multi-PTY opens were in flight, and
   * `spawn-failed` didn't shift the queue at all so its open hung forever.
   */
  private pendingOpens = new Map<string, PendingOpen>();

  /** Latest status (so we can re-emit when subscribers attach). */
  private currentStatus: TransportStatus = { state: "idle" };

  constructor(options: CompanionWsTransportOptions) {
    this.opts = {
      ticketId: options.ticketId,
      origin: options.origin,
      meta: options.meta ?? {},
      mintToken: options.mintToken ?? defaultMintToken,
      healthProbe: options.healthProbe ?? defaultHealthProbe,
      socketFactory: options.socketFactory ?? ((url) => new WebSocket(url)),
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    };
  }

  connect(handlers: TransportHandlers): void {
    this.handlers = handlers;
    void this.run();
  }

  send(frame: ClientFrame): void {
    if (
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.handshakeComplete
    ) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  async openPty(ticketId: string): Promise<string> {
    if (!this.handshakeComplete) {
      // Wait for the next connected status, then queue the request. For S3
      // the panel does not call openPty until connect() resolves to
      // `connected` — this guard is defense in depth.
      throw new Error("transport not yet handshaken");
    }
    // P1-2: mint a per-request correlation id. The server echoes it back on
    // `pty.opened` or `pty.error` so we route the resolution to the EXACT
    // pending promise this open corresponds to.
    const requestId = mintRequestId();
    return new Promise<string>((resolve, reject) => {
      this.pendingOpens.set(requestId, { ticketId, resolve, reject });
      this.send({ t: "pty.open", ticket_id: ticketId, request_id: requestId });
    });
  }

  subscribe(pty_id: string, listener: (f: PtyFrame) => void): () => void {
    let set = this.subscribers.get(pty_id);
    if (!set) {
      set = new Set();
      this.subscribers.set(pty_id, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.subscribers.delete(pty_id);
      }
    };
  }

  write(pty_id: string, data: string): void {
    this.send({ t: "pty.write", pty_id, data });
  }

  resize(pty_id: string, cols: number, rows: number): void {
    this.send({ t: "pty.resize", pty_id, cols, rows });
  }

  closePty(pty_id: string): void {
    this.send({ t: "pty.close", pty_id });
    this.subscribers.delete(pty_id);
  }

  close(): void {
    this.closed = true;
    this.clearHandshakeTimer();
    // Reject any pending opens — the transport is going down.
    for (const p of this.pendingOpens.values()) {
      p.reject(new Error("transport closed"));
    }
    this.pendingOpens.clear();
    this.subscribers.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = undefined;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.currentStatus = {
      state,
      detail,
      sessionId: this.currentStatus.sessionId,
      capabilities: this.capabilities,
      companionStartedAt: this.companionStartedAt,
    };
    this.handlers?.onStatus(this.currentStatus);
  }

  private dispatchPtyFrame(frame: ServerFrame): void {
    if (frame.t === "pty.data" || frame.t === "pty.exit") {
      const subs = this.subscribers.get(frame.pty_id);
      if (subs) {
        let payload: PtyFrame;
        if (frame.t === "pty.data") {
          payload = {
            kind: "pty.data",
            pty_id: frame.pty_id,
            bytes: new TextEncoder().encode(frame.bytes),
          };
        } else {
          payload = {
            kind: "pty.exit",
            pty_id: frame.pty_id,
            code: frame.code,
            signal: frame.signal,
          };
        }
        for (const sub of subs) {
          try {
            sub(payload);
          } catch {
            /* subscriber error must not break the WS */
          }
        }
      }
    }
  }

  private async run(): Promise<void> {
    this.setState("connecting");

    let mint: CompanionTokenResponse;
    try {
      mint = await this.opts.mintToken(this.opts.ticketId, this.opts.origin);
    } catch {
      this.setState(
        "mint-unavailable",
        "Could not mint a Companion session token."
      );
      return;
    }
    if (this.closed) return;

    const port = mint.port || DEFAULT_COMPANION_PORT;

    const healthy = await this.opts.healthProbe(port);
    if (this.closed) return;
    if (!healthy) {
      this.setState("not-detected", "No Companion process is reachable.");
      return;
    }

    const params = new URLSearchParams({
      token: mint.token,
      ticket: this.opts.ticketId,
      session: mint.sessionId,
    });
    if (this.opts.meta.status) params.set("status", this.opts.meta.status);
    if (this.opts.meta.clientSlug)
      params.set("clientSlug", this.opts.meta.clientSlug);
    if (this.opts.meta.title) params.set("title", this.opts.meta.title);
    const url = `ws://127.0.0.1:${port}/?${params.toString()}`;

    let ws: WebSocket;
    try {
      ws = this.opts.socketFactory(url);
    } catch {
      this.setState("not-detected", "Could not open the Companion socket.");
      return;
    }
    this.ws = ws;
    // Track sessionId so the status surface stays consistent across states.
    this.currentStatus = {
      ...this.currentStatus,
      sessionId: mint.sessionId,
    };

    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = undefined;
      if (this.closed || this.handshakeComplete) return;
      this.setState(
        "not-detected",
        "Companion did not complete the handshake in time."
      );
      this.close();
    }, this.opts.handshakeTimeoutMs);

    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = parseServerFrame(
        typeof ev.data === "string" ? ev.data : String(ev.data)
      );
      if (!frame) return;

      if (!this.handshakeComplete) {
        if (frame.t === "pty.error") {
          if (frame.code === "spawn-failed") {
            this.setState("shell-unavailable", frame.detail ?? "");
          } else if (frame.code === "not-authed") {
            this.setState("mint-unavailable", frame.detail ?? "");
          } else {
            this.setState(
              "not-detected",
              `Companion error: ${frame.code}.`
            );
          }
          this.close();
          return;
        }
        if (frame.t !== "hello") {
          this.setState("not-detected", "Companion handshake malformed.");
          this.close();
          return;
        }
        if (!isProtocolCompatible(frame.protocolVersion)) {
          this.setState(
            "protocol-mismatch",
            `Companion protocol v${frame.protocolVersion} is not supported.`
          );
          this.close();
          return;
        }
        // Capability negotiation — intersection drives feature activation.
        this.capabilities = intersectCapabilities(
          frame.capabilities,
          CLIENT_CAPABILITIES
        );
        // Epoch tracking — a new epoch invalidates cached pty_ids.
        const newEpoch = frame.companion_started_at;
        if (
          this.companionStartedAt !== undefined &&
          this.companionStartedAt !== newEpoch
        ) {
          // Subscribers are wiped — they must re-open PTYs.
          this.subscribers.clear();
        }
        this.companionStartedAt = newEpoch;
        this.handshakeComplete = true;
        this.clearHandshakeTimer();
        this.handlers?.onFrame(frame);
        this.setState("connected");
        return;
      }

      // Post-handshake — dispatch typed frames.
      if (frame.t === "pty.opened") {
        // P1-2: route by request_id when present. Older Companion builds
        // (pre-fix) don't echo request_id — fall back to the FIFO-shift the
        // previous protocol assumed, but new clients always send request_id
        // so this fallback only fires during a rolling protocol-bump and is
        // safe (the previous behavior is the worst case).
        const reqId = frame.request_id;
        const pending =
          reqId != null
            ? this.pendingOpens.get(reqId)
            : firstPending(this.pendingOpens);
        if (pending) {
          if (reqId != null) this.pendingOpens.delete(reqId);
          else deleteFirst(this.pendingOpens);
          pending.resolve(frame.pty_id);
        }
        this.handlers?.onFrame(frame);
        return;
      }

      if (frame.t === "pty.error") {
        // P1-2 (gate-review.md): route the error to the EXACT pending-open
        // that triggered it via the echoed request_id. Without this, the
        // previous FIFO shifted the OLDEST pending — wrong for concurrent
        // opens — and `spawn-failed` didn't shift at all so its open hung.
        const reqId = frame.request_id;
        const pending = reqId != null ? this.pendingOpens.get(reqId) : null;
        if (pending) {
          this.pendingOpens.delete(reqId!);
          const detail = frame.detail ? `: ${frame.detail}` : "";
          if (frame.code === "spawn-failed") {
            this.setState("shell-unavailable", frame.detail ?? "");
            pending.reject(new Error(`pty spawn-failed${detail}`));
          } else if (frame.code === "cap-exceeded") {
            pending.reject(new Error(`pty cap exceeded${detail}`));
          } else {
            pending.reject(new Error(`pty.error ${frame.code}${detail}`));
          }
          this.handlers?.onFrame(frame);
          return;
        }

        // No matching request_id — this is a broadcast error (bad-frame,
        // frame-too-large, unknown-pty on a non-open frame, etc.). Surface
        // via the global toast surface rather than rejecting any specific
        // pending. spawn-failed without a request_id still routes to the
        // shell-unavailable state for the pre-fix handshake path.
        if (frame.code === "spawn-failed") {
          this.setState("shell-unavailable", frame.detail ?? "");
        } else {
          // Defensive: a non-actionable error should not be swallowed
          // silently — give the operator something to see.
          try {
            fireInfoToast(
              `Terminal error: ${frame.code}${
                frame.detail ? ` — ${frame.detail}` : ""
              }`
            );
          } catch {
            /* toast surface not yet registered — non-fatal */
          }
        }
        this.handlers?.onFrame(frame);
        return;
      }

      this.dispatchPtyFrame(frame);
      this.handlers?.onFrame(frame);
    });

    ws.addEventListener("close", () => {
      if (this.closed) return;
      if (!this.handshakeComplete) {
        this.setState(
          "not-detected",
          "Companion socket closed before handshake."
        );
      } else {
        // A post-handshake close means the Companion went away — surface as
        // not-detected so the panel shows the reconnect-able failure UI.
        this.setState("not-detected", "Companion socket closed.");
      }
    });

    ws.addEventListener("error", () => {
      if (this.closed) return;
      if (!this.handshakeComplete) {
        this.setState("not-detected", "Companion socket error.");
      }
    });
  }
}
