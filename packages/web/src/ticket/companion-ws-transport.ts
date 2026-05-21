// dispatch — companion-ws-transport: the real Companion WebSocket transport.
//
// A `TerminalTransport` implementation backed by the local Companion. It:
//   1. mints a scoped connection token via POST /api/companion/sessions
//      (through `api-client.ts` — the lint-allowed web→backend touchpoint),
//   2. probes GET http://127.0.0.1:<port>/healthz for discovery (OQ-S4),
//   3. opens the loopback WebSocket with the token + ticket + session scope,
//   4. validates the explicit handshake — a `session-meta` frame with a
//      protocolVersion this web app speaks — so an unauthenticated
//      port-squatter that cannot complete the handshake is treated as
//      "Companion offline" (it is NOT silently trusted; spec A12c),
//   5. maps frames onto the `TerminalTransport` contract.
//
// `PanelTerminal` never sees any of this — it depends only on the
// `TerminalTransport` interface (the seam).

import type {
  TerminalTransport,
  TransportHandlers,
  ConnectionState,
} from "./terminal-transport.js";
import {
  parseServerFrame,
  isProtocolCompatible,
  type ClientFrame,
} from "./companion-protocol.js";
import { apiClient } from "../lib/api-client.js";

/** Default fixed loopback port the Companion listens on (OQ-S4). */
const DEFAULT_COMPANION_PORT = 7720;

/** How a connection token is obtained — injected so tests need no live api. */
export interface CompanionTokenResponse {
  token: string;
  sessionId: string;
  port: number;
}

export type MintTokenFn = (ticketId: string, origin: string) => Promise<CompanionTokenResponse>;

/** A probe of GET /healthz — injected so tests need no live Companion. */
export type HealthProbeFn = (port: number) => Promise<boolean>;

/** A WebSocket factory — injected so tests need no real socket. */
export type SocketFactory = (url: string) => WebSocket;

/**
 * Optional Ticket metadata injected into the spawned `claude` session as
 * opening context (OQ-S2). The Companion reads these from the WS URL query
 * params and builds the context preamble. `ticketId` is always carried (it is
 * the token scope); these add the human-readable fields.
 */
export interface CompanionSessionMeta {
  /** Ticket status — e.g. "new", "on-you". */
  status?: string;
  /** Client slug, when the panel has the Account loaded. */
  clientSlug?: string;
  /** Ticket title, when available. */
  title?: string;
}

export interface CompanionWsTransportOptions {
  /** The ticket the session is for — scopes the minted token. */
  ticketId: string;
  /** The dispatch web app origin — audience-binds the token. */
  origin: string;
  /** Optional Ticket metadata for the context-injection preamble (A15). */
  meta?: CompanionSessionMeta;
  /** Token mint. Defaults to POST /api/companion/sessions via api-client. */
  mintToken?: MintTokenFn;
  /** Health probe. Defaults to a fetch of GET /healthz. */
  healthProbe?: HealthProbeFn;
  /** Socket factory. Defaults to `new WebSocket(url)`. */
  socketFactory?: SocketFactory;
}

/** Default token mint — POST /api/companion/sessions via the api-client. */
function defaultMintToken(
  ticketId: string,
  origin: string
): Promise<CompanionTokenResponse> {
  return apiClient.post<CompanionTokenResponse>("/api/companion/sessions", {
    ticketId,
    origin,
  });
}

/** Default health probe — GET /healthz on the fixed loopback port. */
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
  };

  private ws: WebSocket | undefined;
  private handlers: TransportHandlers | undefined;
  private closed = false;
  private handshakeComplete = false;

  constructor(options: CompanionWsTransportOptions) {
    this.opts = {
      ticketId: options.ticketId,
      origin: options.origin,
      meta: options.meta ?? {},
      mintToken: options.mintToken ?? defaultMintToken,
      healthProbe: options.healthProbe ?? defaultHealthProbe,
      socketFactory: options.socketFactory ?? ((url) => new WebSocket(url)),
    };
  }

  connect(handlers: TransportHandlers): void {
    this.handlers = handlers;
    void this.run();
  }

  send(frame: ClientFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.handshakeComplete) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  resize(cols: number, rows: number): void {
    this.send({ t: "resize", cols, rows });
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = undefined;
    }
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.handlers?.onStatus({ state, detail });
  }

  private async run(): Promise<void> {
    this.setState("connecting");

    // Step 1 — mint a scoped connection token. A mint failure → mint-unavailable.
    let mint: CompanionTokenResponse;
    try {
      mint = await this.opts.mintToken(this.opts.ticketId, this.opts.origin);
    } catch {
      this.setState("mint-unavailable", "Could not mint a Companion session token.");
      return;
    }
    if (this.closed) return;

    const port = mint.port || DEFAULT_COMPANION_PORT;

    // Step 2 — discovery: probe /healthz. No Companion → not-detected.
    const healthy = await this.opts.healthProbe(port);
    if (this.closed) return;
    if (!healthy) {
      this.setState("not-detected", "No Companion process is reachable.");
      return;
    }

    // Step 3 — open the loopback WebSocket, scoped by token + ticket + session.
    // The optional Ticket metadata rides as query params — the Companion reads
    // them into the context-injection preamble (A15 / OQ-S2).
    const params = new URLSearchParams({
      token: mint.token,
      ticket: this.opts.ticketId,
      session: mint.sessionId,
    });
    if (this.opts.meta.status) params.set("status", this.opts.meta.status);
    if (this.opts.meta.clientSlug) params.set("clientSlug", this.opts.meta.clientSlug);
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

    ws.addEventListener("message", (ev: MessageEvent) => {
      const frame = parseServerFrame(
        typeof ev.data === "string" ? ev.data : String(ev.data)
      );
      if (!frame) return;

      // Handshake validation — the first frame MUST be a session-meta whose
      // protocolVersion this web app speaks. A socket that cannot complete
      // this is a fake Companion / port-squatter: treat it as offline (A12c).
      if (!this.handshakeComplete) {
        if (frame.t !== "session-meta") {
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
        this.handshakeComplete = true;
        this.handlers?.onStatus({ state: "connected", sessionId: frame.sessionId });
      }

      this.handlers?.onFrame(frame);
    });

    ws.addEventListener("close", () => {
      if (this.closed) return;
      // A socket that closed before the handshake never proved itself a real
      // Companion → offline. After the handshake, a close is a normal end.
      if (!this.handshakeComplete) {
        this.setState("not-detected", "Companion socket closed before handshake.");
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
