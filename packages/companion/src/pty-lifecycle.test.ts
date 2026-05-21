/**
 * pty-lifecycle.test.ts — no orphaned `claude` process leaks.
 *
 * Exercises (Codex P1-3 / P1-4; spec §3.1.1, §3.1.7, A7b, A7c):
 *   - DIRECT argv — the PTY's spawned argv is `claude` itself, no shell wrapper.
 *   - process-group kill — a spawned PTY tree with a child process is torn down
 *     and no process survives.
 *   - SIGTERM → SIGKILL escalation — a child that ignores SIGTERM is still
 *     reaped by the forced SIGKILL after the grace window.
 *   - heartbeat / idle timeout — a session whose socket has gone silent (the
 *     half-open case) is reaped by the bridge.
 *   - Companion SIGTERM — `closeAll()` tears every live session down.
 *
 * The tests spawn a cheap real shell process group (NOT `claude`, which would
 * hang a headless test) and verify the kill discipline against it. node-pty's
 * UnixTerminal calls setsid() so the spawned child leads its own process group;
 * the negated-pid kill reaches the whole tree. Per-trigger captures against a
 * real `claude` (A7b/A7c) are still gathered in the evidence phase.
 */

import { describe, it, expect, vi } from "vitest";
import { PtySession, KILL_GRACE_MS } from "./pty-session.js";
import { BridgeSession } from "./bridge.js";
import type { TicketContext } from "./context.js";
import * as nodePty from "node-pty";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True if a pid (or process group) is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until `pred()` is true or the deadline elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await waitMs(25);
  }
  return pred();
}

const TEST_CTX: TicketContext = {
  clientSlug: "prorise",
  displayId: "DSP-2901",
  title: "Test ticket",
  status: "in_progress",
};

// ── Direct argv — no shell wrapper (A7b) ─────────────────────────────────────

describe("PtySession — direct argv (A7b)", () => {
  it("spawns the named binary directly with no /bin/bash -lc wrapper", async () => {
    // We host `/bin/sh` here only as a stand-in for `claude` (a real claude
    // would hang). The point under test: spawnedArgv is the binary itself,
    // never a shell -c wrapper around it.
    const session = new PtySession(
      {
        claudeBin: "/bin/sh",
        claudeArgs: ["-c", "sleep 30"],
        cwd: process.cwd(),
        env: process.env,
      },
      { onData: () => {}, onExit: () => {} }
    );

    // spawnedArgv[0] is the binary; there is no intermediate "/bin/bash" "-lc".
    expect(session.spawnedArgv[0]).toBe("/bin/sh");
    expect(session.spawnedArgv).not.toContain("-lc");
    expect(session.pid).toBeGreaterThan(0);

    session.kill();
    await waitFor(() => !isAlive(session.pid));
    expect(isAlive(session.pid)).toBe(false);
  });

  it("records the exact argv it spawned (PID/argv evidence surface)", () => {
    const session = new PtySession(
      { claudeBin: "/bin/sh", claudeArgs: ["-c", "sleep 30"], cwd: process.cwd(), env: process.env },
      { onData: () => {}, onExit: () => {} }
    );
    expect(session.spawnedArgv).toEqual(["/bin/sh", "-c", "sleep 30"]);
    session.kill();
  });
});

// ── Process-group kill — the whole tree (A7c) ────────────────────────────────

describe("PtySession — process-group kill (A7c)", () => {
  it("kill() reaps the PTY leader and its child process", async () => {
    // A shell that spawns a child `sleep` and then waits — a two-level tree.
    // A process-group kill must reach BOTH; a bare pty.kill() of the leader
    // alone would leave the `sleep` orphaned.
    let childPid = 0;
    const session = new PtySession(
      {
        claudeBin: "/bin/sh",
        claudeArgs: ["-c", "sleep 60 & echo CHILD_PID=$!; wait"],
        cwd: process.cwd(),
        env: process.env,
      },
      {
        onData: (chunk) => {
          const m = chunk.match(/CHILD_PID=(\d+)/);
          if (m && m[1]) childPid = Number(m[1]);
        },
        onExit: () => {},
      }
    );

    // Wait for the child to be reported.
    await waitFor(() => childPid > 0);
    expect(childPid).toBeGreaterThan(0);
    expect(isAlive(session.pid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    session.kill();

    // Both the leader AND the grandchild `sleep` must be gone.
    await waitFor(() => !isAlive(session.pid) && !isAlive(childPid));
    expect(isAlive(session.pid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
  });

  it("kill() is idempotent", async () => {
    const session = new PtySession(
      { claudeBin: "/bin/sh", claudeArgs: ["-c", "sleep 30"], cwd: process.cwd(), env: process.env },
      { onData: () => {}, onExit: () => {} }
    );
    session.kill();
    expect(() => session.kill()).not.toThrow();
    expect(session.isKilled).toBe(true);
    await waitFor(() => !isAlive(session.pid));
  });
});

// ── SIGTERM → SIGKILL escalation ─────────────────────────────────────────────

describe("PtySession — SIGTERM→SIGKILL escalation", () => {
  it("escalates to SIGKILL for a child that traps and ignores SIGTERM", async () => {
    // `trap '' TERM HUP` makes the shell ignore both SIGTERM and the SIGHUP
    // a closing PTY would deliver. The shell then loops in a builtin (so it is
    // never blocked inside an un-trappable `sleep`). Only the escalated
    // SIGKILL after the grace window can reap it. The shell echoes TRAP_READY
    // once the trap is installed — we must not fire kill() before the trap is
    // in place (a SIGTERM to the still-exec'ing shell would just kill it).
    let trapReady = false;
    const session = new PtySession(
      {
        claudeBin: "/bin/sh",
        claudeArgs: [
          "-c",
          "trap '' TERM HUP; echo TRAP_READY; while :; do :; done",
        ],
        cwd: process.cwd(),
        env: process.env,
      },
      {
        onData: (chunk) => {
          if (chunk.includes("TRAP_READY")) trapReady = true;
        },
        onExit: () => {},
      }
    );

    await waitFor(() => trapReady);
    expect(trapReady).toBe(true);
    expect(isAlive(session.pid)).toBe(true);

    session.kill();

    // It must NOT be dead before the escalation grace window — it ignores TERM.
    await waitMs(Math.max(0, KILL_GRACE_MS - 600));
    expect(isAlive(session.pid)).toBe(true);

    // After the grace window the forced SIGKILL reaps it.
    await waitFor(() => !isAlive(session.pid), KILL_GRACE_MS + 3000);
    expect(isAlive(session.pid)).toBe(false);
  });
});

// ── Bridge heartbeat / idle timeout — the half-open case ─────────────────────

describe("BridgeSession — idle timeout reaps a silent session", () => {
  it("tears the PTY down when the socket goes silent past the idle window", async () => {
    // A minimal fake WebSocket — never emits a pong, never closes. This is the
    // half-open socket after a laptop sleep: the bridge's idle timer must reap
    // it without waiting for a close that never arrives.
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const fakeWs = {
      readyState: 1,
      on(event: string, cb: (...a: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
        return this;
      },
      send: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
    };

    const bridge = new BridgeSession(fakeWs as never, {
      pty: {
        claudeBin: "/bin/sh",
        claudeArgs: ["-c", "sleep 60"],
        cwd: process.cwd(),
        env: process.env,
      },
      context: TEST_CTX,
      idleTimeoutMs: 300, // tiny window for the test
      heartbeatIntervalMs: 100_000, // long — keep the heartbeat out of the way
    });

    const ptyPid = bridge.session.pid;
    expect(isAlive(ptyPid)).toBe(true);
    expect(bridge.isTornDown).toBe(false);

    // No traffic, no pong — the idle timer must fire and reap the PTY.
    await waitFor(() => bridge.isTornDown, 3000);
    expect(bridge.isTornDown).toBe(true);

    await waitFor(() => !isAlive(ptyPid));
    expect(isAlive(ptyPid)).toBe(false);
  });
});

// ── claude spawn failure degrades, does NOT crash the Companion (P1-1) ───────
//
// ADR-001 "never hard-fail": pointing `claudeBin` at a binary that does not
// exist must NOT crash the Companion. `node-pty` has two failure shapes:
//   - it can throw SYNCHRONOUSLY (a native-module load error / posix_spawnp
//     failure) — the bridge catches that so it never escapes the upgrade
//     handler;
//   - on macOS it does NOT throw for a missing binary — it returns an IPty and
//     fires a near-immediate failure `onExit`. The bridge classifies that as a
//     spawn failure too.
// Either way: the Companion process survives, a typed `error` frame is sent,
// and the socket closes.

describe("BridgeSession — claude spawn failure degrades (P1-1)", () => {
  /** A fake ws that records every frame sent and whether close() was called. */
  function makeFakeWs() {
    const sent: string[] = [];
    const state = { closed: false };
    const ws = {
      readyState: 1,
      on() {
        return this;
      },
      send: (data: string) => sent.push(data),
      ping: vi.fn(),
      close: () => {
        state.closed = true;
      },
    };
    return { ws, sent, state };
  }

  it("a nonexistent claudeBin → no crash, typed error frame, socket closed", async () => {
    const { ws, sent, state } = makeFakeWs();

    // Constructing the bridge with a binary that does not exist must NOT throw
    // out of the constructor (an uncaught throw is the crash being prevented).
    let bridge: BridgeSession | undefined;
    expect(() => {
      bridge = new BridgeSession(ws as never, {
        pty: {
          claudeBin: "/nonexistent/definitely-not-a-real-binary-xyz",
          claudeArgs: [],
          cwd: process.cwd(),
          env: process.env,
        },
        context: TEST_CTX,
        idleTimeoutMs: 100_000,
        heartbeatIntervalMs: 100_000,
      });
    }).not.toThrow();

    // The failure may surface synchronously (caught spawn throw) or via a
    // near-immediate failure `onExit`. Either way the bridge tears down and a
    // typed `error` frame lands — wait for the teardown.
    await waitFor(() => bridge?.isTornDown === true, 4000);
    expect(bridge?.isTornDown).toBe(true);

    // A typed `error` frame was sent carrying a shipped failure-state code
    // (protocol.ts). No bare `exit`-only outcome — the panel must be able to
    // reach `claude-unusable` / `local-permission-denied`.
    const frames = sent.map((s) => JSON.parse(s) as { t: string; code?: string });
    const errorFrame = frames.find((f) => f.t === "error");
    expect(errorFrame).toBeDefined();
    expect(["claude-unusable", "local-permission-denied"]).toContain(
      errorFrame?.code
    );

    // The socket was closed cleanly.
    expect(state.closed).toBe(true);
  });

  it("the Companion stays alive — a second session spawns fine after a failure", async () => {
    // A spawn failure must not poison the process: the very next connection
    // (a good binary) gets a healthy session.
    const fail = makeFakeWs();
    const failed = new BridgeSession(fail.ws as never, {
      pty: {
        claudeBin: "/nonexistent/definitely-not-a-real-binary-xyz",
        claudeArgs: [],
        cwd: process.cwd(),
        env: process.env,
      },
      context: TEST_CTX,
      idleTimeoutMs: 100_000,
      heartbeatIntervalMs: 100_000,
    });
    await waitFor(() => failed.isTornDown === true, 4000);
    expect(failed.isTornDown).toBe(true);

    // Next connection — a real (stand-in) binary. It spawns normally; the
    // earlier failure did not crash or poison the Companion.
    const ok = makeFakeWs();
    const okBridge = new BridgeSession(ok.ws as never, {
      pty: {
        claudeBin: "/bin/sh",
        claudeArgs: ["-c", "sleep 30"],
        cwd: process.cwd(),
        env: process.env,
      },
      context: TEST_CTX,
      idleTimeoutMs: 100_000,
      heartbeatIntervalMs: 100_000,
    });
    expect(okBridge.session).toBeDefined();
    expect(okBridge.session?.pid).toBeGreaterThan(0);
    expect(okBridge.isTornDown).toBe(false);

    okBridge.teardown("test-cleanup");
    await waitFor(() => !isAlive(okBridge.session?.pid ?? -1));
  });
});

// ── Companion SIGTERM — closeAll tears every live session down ───────────────

describe("Companion shutdown — every session torn down", () => {
  it("buildCompanionServer().closeAll() reaps all live bridged sessions", async () => {
    const { buildCompanionServer } = await import("./main.js");
    const server = buildCompanionServer({
      port: 7720,
      host: "127.0.0.1",
      tokenSecret: "x".repeat(32),
      knowledgeRoot: process.cwd(),
      allowedOrigins: ["http://localhost:5173"],
    });

    // Hand-build two live bridged sessions (bypass the network upgrade — we are
    // testing the shutdown teardown, not the auth path which auth.test covers).
    const mkBridge = () => {
      const fakeWs = {
        readyState: 1,
        on() {
          return this;
        },
        send: vi.fn(),
        ping: vi.fn(),
        close: vi.fn(),
      };
      const bridge = new BridgeSession(fakeWs as never, {
        pty: {
          claudeBin: "/bin/sh",
          claudeArgs: ["-c", "sleep 60"],
          cwd: process.cwd(),
          env: process.env,
        },
        context: TEST_CTX,
        idleTimeoutMs: 100_000,
        heartbeatIntervalMs: 100_000,
      });
      server.liveSessions.add(bridge);
      return bridge;
    };

    const b1 = mkBridge();
    const b2 = mkBridge();
    const pids = [b1.session.pid, b2.session.pid];
    expect(pids.every((p) => isAlive(p))).toBe(true);

    // Companion SIGTERM path.
    server.closeAll();

    expect(b1.isTornDown).toBe(true);
    expect(b2.isTornDown).toBe(true);
    await waitFor(() => pids.every((p) => !isAlive(p)));
    expect(pids.some((p) => isAlive(p))).toBe(false);
  });
});

// ── /healthz discovery endpoint — CORS for the cross-origin probe ────────────
//
// The web app's discovery probe is a cross-origin `fetch` from the dispatch
// origin to `http://127.0.0.1:<port>/healthz`. The browser enforces CORS on
// it. Slice 4 integration surfaced that without an explicit ACAO header the
// browser blocks the probe and the panel wrongly shows "Companion not
// detected". `/healthz` answers CORS for the SAME strict Origin allowlist the
// WS upgrade pins against — and ONLY that allowlist.

describe("/healthz — discovery endpoint CORS (Slice 4 remediation)", () => {
  async function withServer(
    fn: (base: string) => Promise<void>
  ): Promise<void> {
    const { buildCompanionServer } = await import("./main.js");
    const server = buildCompanionServer({
      port: 0,
      host: "127.0.0.1",
      tokenSecret: "x".repeat(32),
      knowledgeRoot: process.cwd(),
      allowedOrigins: ["http://localhost:5173", "https://dispatch.paintos.app"],
    });
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve)
    );
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      server.closeAll();
      await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    }
  }

  it("a GET from an allowlisted Origin gets Access-Control-Allow-Origin", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`, {
        headers: { Origin: "http://localhost:5173" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:5173"
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  it("an OPTIONS preflight from an allowlisted Origin returns 204 with CORS", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`, {
        method: "OPTIONS",
        headers: { Origin: "https://dispatch.paintos.app" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://dispatch.paintos.app"
      );
    });
  });

  it("a GET from a non-allowlisted Origin gets NO ACAO header", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`, {
        headers: { Origin: "https://evil.example.com" },
      });
      // The endpoint still answers (it carries no secret), but with no ACAO
      // the browser blocks the cross-origin read — discovery is not opened up.
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});

// ── node-pty version sanity — the prototype's load-bearing finding ───────────

describe("node-pty pinned version", () => {
  it("node-pty spawn works on this Node line (the 1.1.0/Node-25 trap)", async () => {
    // The whole prototype finding: node-pty 1.1.0 throws posix_spawnp failed
    // on Node 25; 1.2.0-beta.13 works. If this spawn throws, the pin regressed.
    let out = "";
    const exited = new Promise<number>((resolve) => {
      const p = nodePty.spawn("/bin/echo", ["NODE_PTY_OK"], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as { [k: string]: string },
      });
      p.onData((d) => (out += d));
      p.onExit(({ exitCode }) => resolve(exitCode));
    });
    const code = await exited;
    expect(code).toBe(0);
    expect(out).toContain("NODE_PTY_OK");
  });
});
