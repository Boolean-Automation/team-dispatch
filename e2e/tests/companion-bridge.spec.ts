// dispatch E2E — the Companion bridge: auth-rejection matrix + PTY pipe.
//
// Surface: packages/companion — the PTY-over-WebSocket bridge (Spike #1).
// Coverage: A9, A10a, A10b, A11, A12b, A12d (auth rejects); A1/A2/A8-class
//   pipe behavior — PTY bytes over the WebSocket + a resize taking effect.
//
// These tests spawn the REAL Companion bridge modules — the real three-factor
// `authenticateUpgrade`, the real `BridgeSession` PTY↔WS duplex, the real
// `protocol.ts` frame contract — against a BENIGN PTY command (a tiny `sh`
// program), never an interactive `claude` session.
//
// CRITICAL: there is deliberately NO e2e test here that spawns or drives
// interactive `claude`. CI has no `claude` auth and an interactive session
// never exits — it would hang the run. Interactive `claude` was proven by the
// dev phase's one-off L1 evidence (the integration recordings in
// .build-runs/.../evidence/). This file is the PERSISTENT regression layer for
// the bridge mechanics — auth and the pipe — which CI can run deterministically.
//
// This is a Node-level e2e (no browser `page`); Playwright runs it as a
// standard .spec.ts. It exercises the bridge end-to-end over a real loopback
// WebSocket, which the unit tests (auth.test.ts etc.) do not — those test the
// pure functions; this proves the wired, listening server.

import { test, expect } from "@playwright/test";
import { WebSocket } from "ws";
import {
  startBridgeServer,
  mintToken,
  TEST_ORIGIN,
  TEST_SECRET,
  sleep,
  type BridgeServerHandle,
} from "./companion-helpers.js";

// ── A small WebSocket client harness ─────────────────────────────────────────

interface ConnectResult {
  /** Resolved if the upgrade completed (HTTP 101). */
  opened: boolean;
  /** The HTTP status the server wrote on a rejected upgrade, if any. */
  rejectedStatus?: number;
  /** Frames received before close, in order. */
  frames: unknown[];
}

/**
 * Open a WebSocket to the bridge and collect what happens. Resolves once the
 * socket closes OR `holdMs` elapses (then the socket is closed by the harness).
 */
function connect(
  port: number,
  query: Record<string, string>,
  opts: { origin?: string | null; host?: string; holdMs?: number } = {}
): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const qs = new URLSearchParams(query).toString();
    const headers: Record<string, string> = {};
    // `null` means "send an explicit Origin: null"; undefined means omit it.
    if (opts.origin === null) {
      headers["Origin"] = "null";
    } else if (opts.origin !== undefined) {
      headers["Origin"] = opts.origin;
    } else {
      headers["Origin"] = TEST_ORIGIN;
    }
    if (opts.host) headers["Host"] = opts.host;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?${qs}`, { headers });
    const result: ConnectResult = { opened: false, frames: [] };
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    ws.on("upgrade", (res) => {
      // On a 101 the upgrade succeeded; ws does not emit 'upgrade' for rejects.
      result.opened = res.statusCode === 101;
    });
    ws.on("open", () => {
      result.opened = true;
      if (opts.holdMs !== undefined) setTimeout(done, opts.holdMs);
    });
    ws.on("message", (raw) => {
      try {
        result.frames.push(JSON.parse(raw.toString()));
      } catch {
        result.frames.push(raw.toString());
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      result.rejectedStatus = res.statusCode;
      done();
    });
    ws.on("error", () => done());
    ws.on("close", () => done());
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth-rejection matrix — A9 / A10a / A10b / A11 / A12b / A12d
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Companion bridge — auth-rejection matrix", () => {
  let server: BridgeServerHandle;

  test.beforeAll(async () => {
    server = await startBridgeServer();
  });
  test.afterAll(async () => {
    await server.close();
  });

  test("A9 — no token is rejected before any PTY spawns", async () => {
    const res = await connect(server.port, {
      ticket: "DSP-9001",
      session: "sess-a",
    });
    expect(res.opened).toBe(false);
    expect(res.rejectedStatus).toBe(401);
  });

  test("A9 — a bad/forged token (wrong signing secret) is rejected", async () => {
    const forged = mintToken({
      ticketId: "DSP-9001",
      sessionId: "sess-a",
      secret: "the-wrong-secret",
    });
    const res = await connect(server.port, {
      token: forged,
      ticket: "DSP-9001",
      session: "sess-a",
    });
    expect(res.opened).toBe(false);
    expect(res.rejectedStatus).toBe(401);
  });

  test("A12b — an expired token is rejected", async () => {
    const expired = mintToken({
      ticketId: "DSP-9001",
      sessionId: "sess-a",
      ttlSeconds: -10, // already past exp
    });
    const res = await connect(server.port, {
      token: expired,
      ticket: "DSP-9001",
      session: "sess-a",
    });
    expect(res.opened).toBe(false);
    expect(res.rejectedStatus).toBe(401);
  });

  test("A12b — a replayed (single-use jti already consumed) token is rejected", async () => {
    const jti = "replay-jti-fixed-001";
    const first = mintToken({
      ticketId: "DSP-9001",
      sessionId: "sess-replay",
      jti,
    });
    // First use — accepted, consumes the jti.
    const ok = await connect(
      server.port,
      { token: first, ticket: "DSP-9001", session: "sess-replay" },
      { holdMs: 300 }
    );
    expect(ok.opened).toBe(true);

    // Replay the SAME token — the jti is consumed → reject.
    const replay = mintToken({
      ticketId: "DSP-9001",
      sessionId: "sess-replay",
      jti,
    });
    const res = await connect(server.port, {
      token: replay,
      ticket: "DSP-9001",
      session: "sess-replay",
    });
    expect(res.opened).toBe(false);
    expect(res.rejectedStatus).toBe(401);
  });

  test("A12d — a token scoped to ticket X presented for ticket Y is rejected", async () => {
    const tokenForX = mintToken({
      ticketId: "DSP-1111",
      sessionId: "sess-scope",
    });
    const res = await connect(server.port, {
      token: tokenForX,
      ticket: "DSP-2222", // mismatched ticket
      session: "sess-scope",
    });
    expect(res.opened).toBe(false);
    expect(res.rejectedStatus).toBe(401);
  });

  test("A12d — a token scoped to session S presented for session S' is rejected", async () => {
    const tokenForS = mintToken({
      ticketId: "DSP-9001",
      sessionId: "sess-AAA",
    });
    const res = await connect(server.port, {
      token: tokenForS,
      ticket: "DSP-9001",
      session: "sess-BBB", // mismatched session
    });
    expect(res.opened).toBe(false);
    expect(res.rejectedStatus).toBe(401);
  });

  test("A10a — a connection from a wrong Origin is rejected", async () => {
    const token = mintToken({ ticketId: "DSP-9001", sessionId: "sess-o1" });
    const res = await connect(
      server.port,
      { token, ticket: "DSP-9001", session: "sess-o1" },
      { origin: "https://evil.example.com" }
    );
    expect(res.opened).toBe(false);
    expect(res.rejectedStatus).toBe(403);
  });

  test("A10a — a connection with an explicit `null` Origin is rejected", async () => {
    const token = mintToken({ ticketId: "DSP-9001", sessionId: "sess-o2" });
    const res = await connect(
      server.port,
      { token, ticket: "DSP-9001", session: "sess-o2" },
      { origin: null }
    );
    expect(res.opened).toBe(false);
    expect(res.rejectedStatus).toBe(403);
  });

  test("A10b — a connection with a spoofed (non-loopback) Host is rejected", async () => {
    // The shape a DNS-rebinding attack arrives with: Host: evil.com.
    const token = mintToken({ ticketId: "DSP-9001", sessionId: "sess-h1" });
    const res = await connect(
      server.port,
      { token, ticket: "DSP-9001", session: "sess-h1" },
      { host: "evil.com" }
    );
    expect(res.opened).toBe(false);
    expect(res.rejectedStatus).toBe(403);
  });

  test("A8 — a valid token + correct Origin + loopback Host is accepted", async () => {
    const token = mintToken({ ticketId: "DSP-9001", sessionId: "sess-ok" });
    const res = await connect(
      server.port,
      { token, ticket: "DSP-9001", session: "sess-ok" },
      { holdMs: 400 }
    );
    expect(res.opened).toBe(true);
    // The first frame on an accepted connection is the session-meta handshake.
    const meta = res.frames[0] as Record<string, unknown> | undefined;
    expect(meta?.t).toBe("session-meta");
    expect(typeof meta?.sessionId).toBe("string");
    expect(meta?.protocolVersion).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A11 — loopback-only bind: the bridge is not reachable off-loopback
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Companion bridge — loopback-only bind (A11)", () => {
  test("the bridge binds 127.0.0.1 and a 0.0.0.0-host upgrade is host-pinned out", async () => {
    const server = await startBridgeServer();
    try {
      // The server is listening on 127.0.0.1 only (startBridgeServer binds
      // "127.0.0.1"). A connection whose Host header claims a non-loopback
      // address — the off-loopback / rebinding shape — is rejected by the
      // Host pin even though the TCP socket reached the loopback listener.
      const token = mintToken({ ticketId: "DSP-9001", sessionId: "sess-lan" });
      const res = await connect(
        server.port,
        { token, ticket: "DSP-9001", session: "sess-lan" },
        { host: `192.168.1.42:${server.port}` }
      );
      expect(res.opened).toBe(false);
      expect(res.rejectedStatus).toBe(403);
    } finally {
      await server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The PTY-over-WebSocket pipe — A1/A2-class, proven with a BENIGN command
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Companion bridge — PTY-over-WebSocket pipe (benign command)", () => {
  test("PTY stdout bytes arrive over the WebSocket", async () => {
    // Benign command: `sh -c` echoing a unique token, then exit. NOT `claude`.
    const marker = `BRIDGE_PIPE_OK_${Date.now()}`;
    const server = await startBridgeServer({
      claudeBin: "/bin/sh",
      claudeArgs: ["-c", `echo ${marker}`],
    });
    try {
      const token = mintToken({ ticketId: "DSP-9001", sessionId: "sess-pipe" });
      const res = await connect(
        server.port,
        { token, ticket: "DSP-9001", session: "sess-pipe" },
        { holdMs: 1200 }
      );
      expect(res.opened).toBe(true);

      // Concatenate every `data` frame's payload — the PTY's stdout.
      const out = res.frames
        .filter(
          (f): f is { t: "data"; d: string } =>
            typeof f === "object" &&
            f !== null &&
            (f as { t?: string }).t === "data"
        )
        .map((f) => f.d)
        .join("");
      expect(out).toContain(marker);

      // The PTY also self-exits → the bridge sends an `exit` frame.
      const exitFrame = res.frames.find(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as { t?: string }).t === "exit"
      );
      expect(exitFrame).toBeDefined();
    } finally {
      await server.close();
    }
  });

  test("keystrokes typed over the WebSocket reach the PTY and echo back", async () => {
    // Benign interactive program: `cat` echoes whatever is written to it.
    const server = await startBridgeServer({
      claudeBin: "/bin/cat",
      claudeArgs: [],
    });
    try {
      const token = mintToken({ ticketId: "DSP-9001", sessionId: "sess-echo" });
      const qs = new URLSearchParams({
        token,
        ticket: "DSP-9001",
        session: "sess-echo",
      }).toString();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?${qs}`, {
        headers: { Origin: TEST_ORIGIN },
      });

      const received: string[] = [];
      const opened = await new Promise<boolean>((resolve) => {
        ws.on("open", () => resolve(true));
        ws.on("error", () => resolve(false));
        ws.on("unexpected-response", () => resolve(false));
      });
      expect(opened).toBe(true);

      ws.on("message", (raw) => {
        try {
          const f = JSON.parse(raw.toString());
          if (f.t === "data") received.push(f.d);
        } catch {
          /* ignore */
        }
      });

      // Type a `data` frame — the bridge writes it into the PTY; `cat` echoes.
      const typed = "hello-from-the-panel\n";
      ws.send(JSON.stringify({ t: "data", d: typed }));
      await sleep(700);

      const echoed = received.join("");
      expect(echoed).toContain("hello-from-the-panel");

      ws.close();
    } finally {
      await server.close();
    }
  });

  test("a resize frame takes effect — the PTY reflows to the new column count", async () => {
    // Benign program: a shell that, on demand, prints its column count.
    const server = await startBridgeServer({
      claudeBin: "/bin/sh",
      claudeArgs: [],
    });
    try {
      const token = mintToken({ ticketId: "DSP-9001", sessionId: "sess-resz" });
      const qs = new URLSearchParams({
        token,
        ticket: "DSP-9001",
        session: "sess-resz",
      }).toString();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?${qs}`, {
        headers: { Origin: TEST_ORIGIN },
      });

      const received: string[] = [];
      const opened = await new Promise<boolean>((resolve) => {
        ws.on("open", () => resolve(true));
        ws.on("error", () => resolve(false));
        ws.on("unexpected-response", () => resolve(false));
      });
      expect(opened).toBe(true);
      ws.on("message", (raw) => {
        try {
          const f = JSON.parse(raw.toString());
          if (f.t === "data") received.push(f.d);
        } catch {
          /* ignore */
        }
      });

      // Send a resize frame, then ask the PTY its column count.
      ws.send(JSON.stringify({ t: "resize", cols: 137, rows: 41 }));
      await sleep(150);
      ws.send(JSON.stringify({ t: "data", d: "echo COLS_IS_$(tput cols)\n" }));
      await sleep(700);

      const out = received.join("");
      // `tput cols` reports the live PTY width — proof the resize frame took.
      expect(out).toContain("COLS_IS_137");

      ws.send(JSON.stringify({ t: "data", d: "exit\n" }));
      await sleep(150);
      ws.close();
    } finally {
      await server.close();
    }
  });
});
