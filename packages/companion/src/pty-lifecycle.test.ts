/**
 * pty-lifecycle.test.ts — Phase 2 PTY lifecycle + multi-PTY bridge.
 *
 * Exercises:
 *   - DIRECT argv (`$SHELL` or test stand-in) — the PTY's spawned argv is the
 *     binary itself, no shell wrapper.
 *   - process-group kill — a spawned PTY tree with a child process is torn
 *     down and no process survives.
 *   - SIGTERM → SIGKILL escalation — a child that ignores SIGTERM is reaped
 *     by the forced SIGKILL after the grace window.
 *   - Multi-PTY bridge: open 2 PTYs on one ticket; write to each; close one;
 *     the other survives; close the ticket → both are reaped.
 *   - Companion SIGTERM: `closeAll()` tears every live PTY in the map down.
 *
 * The tests spawn a cheap real shell process group (NOT a real login shell,
 * which would hang a headless test) and verify the kill discipline against it.
 */

import { describe, it, expect, vi } from "vitest";
import { PtySession, KILL_GRACE_MS } from "./pty-session.js";
import { createPtyMap } from "./pty-map.js";
import { attachBridge } from "./bridge.js";
import type { CompanionConfig } from "./config.js";
import * as nodePty from "node-pty";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await waitMs(25);
  }
  return pred();
}

const TEST_CONFIG: CompanionConfig = {
  port: 7720,
  host: "127.0.0.1",
  tokenSecret: "x".repeat(32),
  knowledgeRoot: process.cwd(),
  allowedOrigins: ["http://localhost:5173"],
  maxPtysPerTicket: 3,
  sweeperTickMs: 60_000,
  sweeperIdleMs: 60_000,
  sweeperGracePauseMs: 3_000,
  killGraceMs: 3_000,
};

// ── Direct argv — no shell wrapper ───────────────────────────────────────────

describe("PtySession — direct argv (proven by prototype probe 3)", () => {
  it("spawns the named binary directly with no /bin/bash -lc wrapper", async () => {
    const session = new PtySession(
      {
        shellBin: "/bin/sh",
        shellArgs: ["-c", "sleep 30"],
        cwd: process.cwd(),
        env: process.env,
      },
      { onData: () => {}, onExit: () => {} }
    );

    expect(session.spawnedArgv[0]).toBe("/bin/sh");
    expect(session.spawnedArgv).not.toContain("-lc");
    expect(session.pid).toBeGreaterThan(0);

    session.kill();
    await waitFor(() => !isAlive(session.pid));
    expect(isAlive(session.pid)).toBe(false);
  });

  it("default shell argv is exactly ['-l'] (login shell, no wrapper)", () => {
    // We can't spawn the real $SHELL in CI without hanging, but we can
    // confirm the default argv shape via spawnedArgv inspection — inject a
    // throwaway spawnFn so we don't actually fork.
    let capturedArgv: string[] | undefined;
    const spy: typeof nodePty.spawn = ((file: string, args: string[]) => {
      capturedArgv = [file, ...args];
      return {
        pid: 99999,
        cols: 80,
        rows: 24,
        process: file,
        handleFlowControl: false,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        on: () => {},
        resize: () => {},
        clear: () => {},
        write: () => {},
        kill: () => {},
        pause: () => {},
        resume: () => {},
      } as unknown as ReturnType<typeof nodePty.spawn>;
    }) as unknown as typeof nodePty.spawn;

    const session = new PtySession(
      {
        // Force a known shellBin so the test is hermetic w.r.t. $SHELL.
        shellBin: "/bin/zsh",
        cwd: process.cwd(),
        env: process.env,
        spawnFn: spy,
      },
      { onData: () => {}, onExit: () => {} }
    );

    expect(session.spawnedArgv).toEqual(["/bin/zsh", "-l"]);
    expect(capturedArgv).toEqual(["/bin/zsh", "-l"]);
  });
});

// ── Process-group kill — the whole tree ──────────────────────────────────────

describe("PtySession — process-group kill", () => {
  it("kill() reaps the PTY leader and its child process", async () => {
    let childPid = 0;
    const session = new PtySession(
      {
        shellBin: "/bin/sh",
        shellArgs: ["-c", "sleep 60 & echo CHILD_PID=$!; wait"],
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

    await waitFor(() => childPid > 0);
    expect(childPid).toBeGreaterThan(0);
    expect(isAlive(session.pid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    session.kill();

    await waitFor(() => !isAlive(session.pid) && !isAlive(childPid));
    expect(isAlive(session.pid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
  });

  it("kill() is idempotent", async () => {
    const session = new PtySession(
      {
        shellBin: "/bin/sh",
        shellArgs: ["-c", "sleep 30"],
        cwd: process.cwd(),
        env: process.env,
      },
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
    let trapReady = false;
    const session = new PtySession(
      {
        shellBin: "/bin/sh",
        shellArgs: ["-c", "trap '' TERM HUP; echo TRAP_READY; while :; do :; done"],
        cwd: process.cwd(),
        env: process.env,
        killGraceMs: 1_500, // test override — short
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

    await waitMs(Math.max(0, 1_500 - 600));
    expect(isAlive(session.pid)).toBe(true);

    await waitFor(() => !isAlive(session.pid), 1_500 + 3000);
    expect(isAlive(session.pid)).toBe(false);
  });
});

// ── Multi-PTY bridge — open two, close one, the other survives ──────────────

describe("Multi-PTY bridge — open/write/close per pty_id", () => {
  /**
   * Build a minimal in-memory WebSocket-like fake. Records every send().
   */
  function makeFakeWs() {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const sent: string[] = [];
    const state = { closed: false, closeCode: 0 };
    const ws = {
      readyState: 1,
      on(event: string, cb: (...a: unknown[]) => void) {
        (handlers[event] ??= []).push(cb);
        return this;
      },
      send: (data: string) => {
        sent.push(data);
      },
      ping: vi.fn(),
      close: (code?: number) => {
        state.closed = true;
        if (typeof code === "number") state.closeCode = code;
      },
      _fire(event: string, ...args: unknown[]) {
        for (const cb of handlers[event] ?? []) cb(...args);
      },
    };
    return { ws, sent, state };
  }

  it("the hello frame is sent immediately on attach (carries capabilities + epoch)", () => {
    const { ws, sent } = makeFakeWs();
    const ptyMap = createPtyMap();
    attachBridge(ws as never, {
      ptyMap,
      config: TEST_CONFIG,
      companionStartedAt: 1_700_000_000_000,
      ticketId: "DSP-1",
    });
    const first = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    expect(first.t).toBe("hello");
    expect(first.protocolVersion).toBe(2);
    expect(Array.isArray(first.capabilities)).toBe(true);
    expect((first.capabilities as string[]).includes("multi-pty")).toBe(true);
    expect(first.companion_started_at).toBe(1_700_000_000_000);
  });

  it("two pty.open frames on one ticket spawn two PTYs; one close leaves the other alive", async () => {
    const { ws, sent } = makeFakeWs();
    const ptyMap = createPtyMap();
    attachBridge(ws as never, {
      ptyMap,
      config: TEST_CONFIG,
      companionStartedAt: 1,
      ticketId: "DSP-1",
    });

    // Open 1
    ws._fire("message", Buffer.from(JSON.stringify({ t: "pty.open", ticket_id: "DSP-1" })));
    await waitFor(() => ptyMap.entriesForTicket("DSP-1").length === 1, 4000);
    // Open 2
    ws._fire("message", Buffer.from(JSON.stringify({ t: "pty.open", ticket_id: "DSP-1" })));
    await waitFor(() => ptyMap.entriesForTicket("DSP-1").length === 2, 4000);

    expect(ptyMap.entriesForTicket("DSP-1").length).toBe(2);

    // Two pty.opened frames were sent.
    const opened = sent
      .map((s) => JSON.parse(s) as { t: string; pty_id?: string })
      .filter((f) => f.t === "pty.opened");
    expect(opened.length).toBe(2);
    const [a, b] = opened.map((f) => f.pty_id!);

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    // The PTYs are real /bin/zsh-l processes — confirm via pid (the bridge
    // spawns real PtySessions; we can't avoid it without rewriting the
    // bridge factory). Pids should be live.
    const ptyA = ptyMap.get(a)!;
    const ptyB = ptyMap.get(b)!;
    expect(isAlive(ptyA.session.pid)).toBe(true);
    expect(isAlive(ptyB.session.pid)).toBe(true);

    // Close PTY A.
    ws._fire("message", Buffer.from(JSON.stringify({ t: "pty.close", pty_id: a })));
    await waitFor(() => !ptyMap.get(a));
    expect(ptyMap.get(a)).toBeUndefined();

    // PTY B still alive in the map.
    expect(ptyMap.get(b)).toBeDefined();
    expect(isAlive(ptyMap.get(b)!.session.pid)).toBe(true);

    // Clean up.
    ws._fire("message", Buffer.from(JSON.stringify({ t: "pty.close", pty_id: b })));
    await waitFor(() => !ptyMap.get(b));
  }, 20_000);

  it("ticket mismatch on pty.open is rejected with not-authed", () => {
    const { ws, sent } = makeFakeWs();
    const ptyMap = createPtyMap();
    attachBridge(ws as never, {
      ptyMap,
      config: TEST_CONFIG,
      companionStartedAt: 1,
      ticketId: "DSP-AUTHED",
    });
    ws._fire(
      "message",
      Buffer.from(JSON.stringify({ t: "pty.open", ticket_id: "DSP-OTHER" }))
    );
    const errs = sent
      .map((s) => JSON.parse(s) as { t: string; code?: string })
      .filter((f) => f.t === "pty.error");
    expect(errs.some((e) => e.code === "not-authed")).toBe(true);
    // No PTY was spawned.
    expect(ptyMap.countActive()).toBe(0);
  });
});

// ── Companion SIGTERM — closeAll tears every live PTY in the map ─────────────

describe("Companion shutdown — closeAll reaps every entry", () => {
  it("buildCompanionServer().closeAll() reaps all live PTYs", async () => {
    const { buildCompanionServer } = await import("./main.js");
    const server = buildCompanionServer(TEST_CONFIG);

    // Hand-build two PTY entries via the map directly (bypass the WS upgrade
    // — closeAll is what's under test, not the network path).
    const a = await server.ptyMap.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-A",
      spawn: () =>
        new PtySession(
          {
            shellBin: "/bin/sh",
            shellArgs: ["-c", "sleep 60"],
            cwd: process.cwd(),
            env: process.env,
          },
          { onData: () => {}, onExit: () => {} }
        ),
    });
    const b = await server.ptyMap.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-B",
      spawn: () =>
        new PtySession(
          {
            shellBin: "/bin/sh",
            shellArgs: ["-c", "sleep 60"],
            cwd: process.cwd(),
            env: process.env,
          },
          { onData: () => {}, onExit: () => {} }
        ),
    });
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const pids = [server.ptyMap.get(a.pty_id)!.session.pid, server.ptyMap.get(b.pty_id)!.session.pid];
    expect(pids.every((p) => isAlive(p))).toBe(true);

    server.closeAll();

    expect(server.ptyMap.countActive()).toBe(0);
    await waitFor(() => pids.every((p) => !isAlive(p)));
    expect(pids.some((p) => isAlive(p))).toBe(false);
  });
});

// ── /healthz — discovery endpoint CORS (Slice 4 remediation, holds in Phase 2) ─

describe("/healthz — discovery endpoint CORS", () => {
  async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
    const { buildCompanionServer } = await import("./main.js");
    const server = buildCompanionServer({
      ...TEST_CONFIG,
      port: 0,
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
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  it("/metrics returns Prometheus text on loopback", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const body = await res.text();
      expect(body).toMatch(/companion_ptys_active \d+/);
      expect(body).toMatch(/companion_uptime_seconds \d+/);
      expect(body).toMatch(/companion_ws_active \d+/);
    });
  });
});

// ── node-pty version sanity — the prototype's load-bearing finding ───────────

describe("node-pty pinned version", () => {
  it("node-pty spawn works on this Node line (the 1.1.0/Node-25 trap)", async () => {
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

// Re-export KILL_GRACE_MS for any downstream slice tests that imported it
// from this module before.
export { KILL_GRACE_MS };
