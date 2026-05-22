// terminal-transport.test.tsx — the Phase 2 multi-PTY degradation-seam proof.
//
// The seam is real only if every transport (the real Companion WS transport,
// the stub fallback transport, and any future implementations) satisfies the
// SAME `TerminalTransport` type and the panel + popout accept either with no
// change.
//
// This test covers:
//   1. Both transports are assignable to `TerminalTransport` (type-level).
//   2. The stub `connect()` resolves to a `degraded` state.
//   3. `CompanionWsTransport` resolves to `not-detected` when no Companion
//      answers /healthz; to `mint-unavailable` when the token mint fails;
//      to `not-detected` after the silent-socket handshake timeout.

import React from "react";
import { describe, it, expect } from "vitest";
import type {
  TerminalTransport,
  TransportStatus,
} from "./terminal-transport.js";
import { FallbackTransportStub } from "./fallback-transport.stub.js";
import { CompanionWsTransport } from "./companion-ws-transport.js";

// ── 1. Both transports satisfy the same interface ────────────────────────────

describe("TerminalTransport seam — type assignability", () => {
  it("FallbackTransportStub is assignable to TerminalTransport", () => {
    const stub: TerminalTransport = new FallbackTransportStub();
    expect(typeof stub.connect).toBe("function");
    expect(typeof stub.send).toBe("function");
    expect(typeof stub.resize).toBe("function");
    expect(typeof stub.openPty).toBe("function");
    expect(typeof stub.subscribe).toBe("function");
    expect(typeof stub.write).toBe("function");
    expect(typeof stub.closePty).toBe("function");
    expect(typeof stub.close).toBe("function");
  });

  it("CompanionWsTransport is assignable to TerminalTransport", () => {
    const real: TerminalTransport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
    });
    expect(typeof real.connect).toBe("function");
    expect(typeof real.send).toBe("function");
    expect(typeof real.resize).toBe("function");
    expect(typeof real.openPty).toBe("function");
    expect(typeof real.subscribe).toBe("function");
    expect(typeof real.write).toBe("function");
    expect(typeof real.closePty).toBe("function");
    expect(typeof real.close).toBe("function");
  });
});

// ── 2. The stub routes into the seam (degraded), not a dead end ──────────────

describe("FallbackTransportStub — defined degradation state", () => {
  it("connect() resolves to a `degraded` state", () => {
    const stub = new FallbackTransportStub();
    let last: TransportStatus | undefined;
    stub.connect({
      onFrame: () => {},
      onStatus: (s) => {
        last = s;
      },
    });
    expect(last?.state).toBe("degraded");
    stub.close();
  });

  it("send() throws — there is no Phase-2 engine behind the stub", () => {
    const stub = new FallbackTransportStub();
    stub.connect({ onFrame: () => {}, onStatus: () => {} });
    expect(() =>
      stub.send({ t: "pty.write", pty_id: "p", data: "ls\n" })
    ).toThrowError(/Phase 2/);
  });

  it("openPty() rejects — no engine behind the stub", async () => {
    const stub = new FallbackTransportStub();
    stub.connect({ onFrame: () => {}, onStatus: () => {} });
    await expect(stub.openPty("DSP-2901")).rejects.toThrow(/Phase 2/);
  });

  it("write/resize/closePty are defined no-ops (do not throw)", () => {
    const stub = new FallbackTransportStub();
    stub.connect({ onFrame: () => {}, onStatus: () => {} });
    expect(() => stub.write("p", "x")).not.toThrow();
    expect(() => stub.resize("p", 80, 24)).not.toThrow();
    expect(() => stub.closePty("p")).not.toThrow();
  });
});

// ── 3 & 4. The real transport degrades cleanly — no hang, no throw ───────────

describe("CompanionWsTransport — clean degradation (A14 / A12c)", () => {
  it("resolves to `not-detected` when no Companion answers /healthz", async () => {
    const transport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
      mintToken: async () => ({
        token: "fixture.token.value",
        sessionId: "sess-fixture",
        port: 7720,
      }),
      healthProbe: async () => false,
    });

    const state = await new Promise<string>((resolve) => {
      transport.connect({
        onFrame: () => {},
        onStatus: (s) => {
          if (s.state !== "connecting") resolve(s.state);
        },
      });
    });

    expect(state).toBe("not-detected");
    transport.close();
  });

  it("resolves to `mint-unavailable` when the token mint fails", async () => {
    const transport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
      mintToken: async () => {
        throw new Error("POST /api/companion/sessions 503");
      },
      healthProbe: async () => true,
    });

    const state = await new Promise<string>((resolve) => {
      transport.connect({
        onFrame: () => {},
        onStatus: (s) => {
          if (s.state !== "connecting") resolve(s.state);
        },
      });
    });

    expect(state).toBe("mint-unavailable");
    transport.close();
  });

  it("resolves to `not-detected` when the socket accepts but stays silent (P1-2)", async () => {
    let socketClosed = false;
    const silentSocket = {
      readyState: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {
        socketClosed = true;
      },
      send: () => {},
    };

    const transport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
      mintToken: async () => ({
        token: "fixture.token.value",
        sessionId: "sess-fixture",
        port: 7720,
      }),
      healthProbe: async () => true,
      socketFactory: () => silentSocket as unknown as WebSocket,
      handshakeTimeoutMs: 150,
    });

    const start = Date.now();
    const state = await new Promise<string>((resolve) => {
      transport.connect({
        onFrame: () => {},
        onStatus: (s) => {
          if (s.state !== "connecting") resolve(s.state);
        },
      });
    });
    const elapsed = Date.now() - start;

    expect(state).toBe("not-detected");
    expect(elapsed).toBeLessThan(2000);
    expect(socketClosed).toBe(true);
    transport.close();
  });
});

// ── 5. Phase 2 multi-PTY frame handling ──────────────────────────────────────

describe("CompanionWsTransport — Phase 2 multi-PTY frames", () => {
  /**
   * A stub socket whose `addEventListener` records the message handler so the
   * test can simulate inbound frames. The handshake is completed by firing a
   * synthetic `hello` frame on the captured handler.
   */
  function makeRecordingSocket() {
    const listeners: Record<string, ((ev: unknown) => void)[]> = {
      message: [],
      open: [],
      close: [],
      error: [],
    };
    const sent: string[] = [];
    const sock = {
      readyState: 1,
      addEventListener(ev: string, fn: (ev: unknown) => void) {
        (listeners[ev] ?? (listeners[ev] = [])).push(fn);
      },
      removeEventListener() {},
      close() {
        sock.readyState = 3;
      },
      send(data: string) {
        sent.push(data);
      },
      _emit(ev: string, payload: unknown) {
        for (const l of listeners[ev] ?? []) l(payload);
      },
    };
    return { sock, sent, listeners };
  }

  it("intersects capabilities and dispatches pty.data to subscribers", async () => {
    const { sock } = makeRecordingSocket();
    const transport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
      mintToken: async () => ({
        token: "tok",
        sessionId: "sess-x",
        port: 7720,
      }),
      healthProbe: async () => true,
      socketFactory: () => sock as unknown as WebSocket,
    });

    let connectedStatus: TransportStatus | null = null;
    transport.connect({
      onFrame: () => {},
      onStatus: (s) => {
        if (s.state === "connected") connectedStatus = s;
      },
    });

    // Wait one microtask tick so the mint/health promises resolve.
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));

    // Server sends `hello`.
    sock._emit("message", {
      data: JSON.stringify({
        t: "hello",
        protocolVersion: 2,
        companionVersion: "0.1.0",
        capabilities: ["unicode11", "search", "ligatures", "weblinks", "serialize"],
        companion_started_at: 1_000_000,
      }),
    });

    expect(connectedStatus).toBeTruthy();
    expect(connectedStatus!.capabilities).toEqual(
      expect.arrayContaining(["unicode11", "search", "ligatures"])
    );
    expect(connectedStatus!.companionStartedAt).toBe(1_000_000);

    // Subscribe to a pty and emit a pty.data — listener should fire.
    const received: { kind: string; pty_id: string }[] = [];
    const unsub = transport.subscribe("pty-xxx", (f) => {
      received.push({ kind: f.kind, pty_id: f.pty_id });
    });

    sock._emit("message", {
      data: JSON.stringify({
        t: "pty.data",
        pty_id: "pty-xxx",
        bytes: "hello",
      }),
    });

    expect(received).toEqual([{ kind: "pty.data", pty_id: "pty-xxx" }]);
    unsub();
    transport.close();
  });

  it("openPty() resolves on pty.opened and write() emits pty.write", async () => {
    const { sock, sent } = makeRecordingSocket();
    const transport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
      mintToken: async () => ({
        token: "tok",
        sessionId: "sess-x",
        port: 7720,
      }),
      healthProbe: async () => true,
      socketFactory: () => sock as unknown as WebSocket,
    });

    transport.connect({ onFrame: () => {}, onStatus: () => {} });
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));

    sock._emit("message", {
      data: JSON.stringify({
        t: "hello",
        protocolVersion: 2,
        companionVersion: "0.1.0",
        capabilities: [],
        companion_started_at: 1_000_000,
      }),
    });

    const openP = transport.openPty("DSP-2901");
    // The transport should have written a pty.open frame to the WS.
    expect(sent.some((s) => s.includes('"pty.open"'))).toBe(true);

    sock._emit("message", {
      data: JSON.stringify({ t: "pty.opened", pty_id: "pty-y" }),
    });
    const pid = await openP;
    expect(pid).toBe("pty-y");

    transport.write("pty-y", "ls\r");
    expect(sent.some((s) => s.includes('"pty.write"') && s.includes("ls\\r"))).toBe(
      true
    );

    transport.close();
  });

  it("routes pty.error spawn-failed to the shell-unavailable state", async () => {
    const { sock } = makeRecordingSocket();
    const transport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
      mintToken: async () => ({
        token: "tok",
        sessionId: "sess-x",
        port: 7720,
      }),
      healthProbe: async () => true,
      socketFactory: () => sock as unknown as WebSocket,
    });

    const states: string[] = [];
    transport.connect({
      onFrame: () => {},
      onStatus: (s) => {
        states.push(s.state);
      },
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));

    // Server sends a pre-handshake pty.error with spawn-failed.
    sock._emit("message", {
      data: JSON.stringify({
        t: "pty.error",
        code: "spawn-failed",
        detail: "exec /bin/zsh: not found",
      }),
    });

    expect(states).toContain("shell-unavailable");
    transport.close();
  });
});
