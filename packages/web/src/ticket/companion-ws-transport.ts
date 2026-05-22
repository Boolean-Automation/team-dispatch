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
  /** Pending pty.open awaiters — resolved on the next pty.opened. */
  private pendingOpens: PendingOpen[] = [];

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
    return new Promise<string>((resolve, reject) => {
      this.pendingOpens.push({ ticketId, resolve, reject });
      this.send({ t: "pty.open", ticket_id: ticketId });
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
    for (const p of this.pendingOpens) {
      p.reject(new Error("transport closed"));
    }
    this.pendingOpens = [];
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
        const pending = this.pendingOpens.shift();
        if (pending) {
          pending.resolve(frame.pty_id);
        }
        this.handlers?.onFrame(frame);
        return;
      }

      if (frame.t === "pty.error") {
        if (frame.code === "spawn-failed") {
          this.setState("shell-unavailable", frame.detail ?? "");
          this.handlers?.onFrame(frame);
          return;
        }
        if (frame.code === "cap-exceeded") {
          // Reject the most-recent pending open (the one that hit the cap).
          const pending = this.pendingOpens.shift();
          if (pending) {
            pending.reject(new Error(`pty cap exceeded: ${frame.detail ?? ""}`));
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
