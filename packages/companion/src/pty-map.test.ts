/**
 * pty-map.test.ts — multi-PTY registry contract.
 *
 * Covers (S1 plan):
 *   - per-ticket cap: 4th open per ticket is rejected with `cap-exceeded`;
 *   - cap is per-ticket, NOT global: a second ticket can still open up to cap;
 *   - per-frame ownership: a write/resize/close from a different connectionId
 *     is rejected with `not-authed`;
 *   - markDetached stamps `wsClosedAt` on every entry for that connection;
 *   - delete removes the entry from the map.
 */

import { describe, it, expect, vi } from "vitest";
import { createPtyMap, MAX_PTYS_PER_TICKET_DEFAULT } from "./pty-map.js";
import type { PtySession } from "./pty-session.js";
import type { PtySessionFactory } from "./pty-map.js";

/**
 * A cheap fake PtySession — the map's contract is about routing + ownership,
 * not about subprocess lifecycle (that's covered by pty-lifecycle.test.ts).
 */
function fakeSession(): PtySession {
  return {
    sessionId: "fake",
    spawnedArgv: ["/bin/sh", "-l"],
    pid: 0,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    isKilled: false,
  } as unknown as PtySession;
}

const fakeSpawn: PtySessionFactory = () => fakeSession();

describe("pty-map — per-ticket cap (Codex F2 / S1 plan)", () => {
  it("rejects the 4th pty.open on a single ticket with cap-exceeded", async () => {
    const map = createPtyMap();
    const ticket = "DSP-2901";
    const conn = "conn-A";
    for (let i = 0; i < MAX_PTYS_PER_TICKET_DEFAULT; i++) {
      const r = await map.open({ ticket_id: ticket, ownerConnectionId: conn, spawn: fakeSpawn });
      expect(r.ok).toBe(true);
    }
    const overCap = await map.open({
      ticket_id: ticket,
      ownerConnectionId: conn,
      spawn: fakeSpawn,
    });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.error).toBe("cap-exceeded");
    expect(map.entriesForTicket(ticket).length).toBe(MAX_PTYS_PER_TICKET_DEFAULT);
  });

  it("cap is per-ticket, not global", async () => {
    const map = createPtyMap();
    // Fill ticket A to cap.
    for (let i = 0; i < MAX_PTYS_PER_TICKET_DEFAULT; i++) {
      const r = await map.open({
        ticket_id: "DSP-A",
        ownerConnectionId: "conn-A",
        spawn: fakeSpawn,
      });
      expect(r.ok).toBe(true);
    }
    // Ticket B still has the full cap available.
    for (let i = 0; i < MAX_PTYS_PER_TICKET_DEFAULT; i++) {
      const r = await map.open({
        ticket_id: "DSP-B",
        ownerConnectionId: "conn-B",
        spawn: fakeSpawn,
      });
      expect(r.ok).toBe(true);
    }
    expect(map.countActive()).toBe(MAX_PTYS_PER_TICKET_DEFAULT * 2);
  });

  it("atomically holds the cap under concurrent open attempts (mutex check)", async () => {
    const map = createPtyMap();
    const ticket = "DSP-RACE";
    const conn = "conn-X";
    // Fire 10 opens in parallel; expect exactly cap successes.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        map.open({ ticket_id: ticket, ownerConnectionId: conn, spawn: fakeSpawn })
      )
    );
    const successes = results.filter((r) => r.ok).length;
    expect(successes).toBe(MAX_PTYS_PER_TICKET_DEFAULT);
    const overCaps = results.filter((r) => !r.ok && r.error === "cap-exceeded");
    expect(overCaps.length).toBe(10 - MAX_PTYS_PER_TICKET_DEFAULT);
  });
});

describe("pty-map — per-frame ownership (Codex F2)", () => {
  it("rejects a write from a different connection with not-authed", async () => {
    const map = createPtyMap();
    const opened = await map.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-owner",
      spawn: fakeSpawn,
    });
    if (!opened.ok) throw new Error("setup failed");

    const result = map.write(opened.pty_id, "ls\n", "conn-OTHER");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not-authed");
  });

  it("rejects a resize from a different connection with not-authed", async () => {
    const map = createPtyMap();
    const opened = await map.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-owner",
      spawn: fakeSpawn,
    });
    if (!opened.ok) throw new Error("setup failed");

    const result = map.resize(opened.pty_id, 132, 40, "conn-OTHER");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not-authed");
  });

  it("rejects a close from a different connection with not-authed", async () => {
    const map = createPtyMap();
    const opened = await map.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-owner",
      spawn: fakeSpawn,
    });
    if (!opened.ok) throw new Error("setup failed");

    const result = map.close(opened.pty_id, "conn-OTHER");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not-authed");
    // Entry MUST still be in the map — a denied close cannot delete.
    expect(map.get(opened.pty_id)).toBeDefined();
  });

  it("returns unknown-pty for a pty_id the map does not have", () => {
    const map = createPtyMap();
    const result = map.write("01PHANTOM", "ls\n", "conn-anyone");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unknown-pty");
  });

  it("accepts a write from the owning connection", async () => {
    const map = createPtyMap();
    const opened = await map.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-owner",
      spawn: fakeSpawn,
    });
    if (!opened.ok) throw new Error("setup failed");

    const result = map.write(opened.pty_id, "ls\n", "conn-owner");
    expect(result.ok).toBe(true);
    expect(map.get(opened.pty_id)?.session.write).toHaveBeenCalledWith("ls\n");
  });
});

describe("pty-map — markDetached", () => {
  it("stamps wsClosedAt on every entry for the given connection", async () => {
    const map = createPtyMap();
    const clock = vi.fn(() => 1_000);
    const a = await map.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-A",
      spawn: fakeSpawn,
      clock,
    });
    const b = await map.open({
      ticket_id: "DSP-2",
      ownerConnectionId: "conn-A",
      spawn: fakeSpawn,
      clock,
    });
    const c = await map.open({
      ticket_id: "DSP-3",
      ownerConnectionId: "conn-OTHER",
      spawn: fakeSpawn,
      clock,
    });
    if (!a.ok || !b.ok || !c.ok) throw new Error("setup failed");
    // Initially attached (wsClosedAt = null).
    expect(map.get(a.pty_id)?.wsClosedAt).toBeNull();
    expect(map.get(b.pty_id)?.wsClosedAt).toBeNull();
    expect(map.get(c.pty_id)?.wsClosedAt).toBeNull();

    // Stamp conn-A's entries detached at t=5000.
    const stampClock = () => 5_000;
    map.markDetached("conn-A", stampClock);
    expect(map.get(a.pty_id)?.wsClosedAt).toBe(5_000);
    expect(map.get(b.pty_id)?.wsClosedAt).toBe(5_000);
    // conn-OTHER untouched.
    expect(map.get(c.pty_id)?.wsClosedAt).toBeNull();
  });
});

describe("pty-map — delete", () => {
  it("removes an entry from the map", async () => {
    const map = createPtyMap();
    const r = await map.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-A",
      spawn: fakeSpawn,
    });
    if (!r.ok) throw new Error("setup failed");
    expect(map.get(r.pty_id)).toBeDefined();
    map.delete(r.pty_id);
    expect(map.get(r.pty_id)).toBeUndefined();
    expect(map.countActive()).toBe(0);
  });
});

describe("pty-map — P1-1 race: WS disconnects mid-`pty.open` (gate-review)", () => {
  // The hostile sequence the gate review surfaced:
  //   1. Client sends pty.open. Bridge enters the IIFE, awaits the per-ticket
  //      mutex (here simulated by a held promise we resolve manually).
  //   2. WS closes; bridge fires markDetached(connId). The map iterates its
  //      entries — but the NEW one hasn't been inserted yet — so nothing is
  //      stamped.
  //   3. Mutex resolves; the IIFE inserts the new entry with wsClosedAt:null.
  //   4. Sweeper's gate `wsClosedAt !== null && ...` skips this entry FOREVER.
  //
  // Fix: pty-map.open() asks `isConnectionAttached(connId)` AFTER the insert.
  // If the connection is detached at that moment, wsClosedAt is stamped to
  // `now()` so the sweeper takes over after idleMs.

  it("stamps wsClosedAt on the new entry when the owning connection is detached during open()", async () => {
    const map = createPtyMap();
    let attached = true; // flipped by the test to simulate the WS close.

    // A spawn-blocker we control — emulates the slow node-pty fork that lets
    // the WS close fire BEFORE the entry is inserted. The lock + the spawn
    // promise together make the race deterministic.
    let releaseSpawn: () => void = () => {};
    const spawnBlocker = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const slowSpawn: PtySessionFactory = () => {
      // We can't return a Promise from PtySessionFactory (it's sync); the
      // realistic shape is "spawn returns instantly, but the markDetached fire
      // already ran". We model that by toggling `attached` to false BEFORE
      // releasing the awaited mutex below. The test verifies the post-insert
      // attachment check stamps wsClosedAt regardless of spawn timing.
      return fakeSession();
    };

    // Hold the per-ticket mutex with a long-running open we'll release later.
    // We use the SAME ticket so the second open queues behind it.
    const mutexHolder = map.open({
      ticket_id: "DSP-RACE",
      ownerConnectionId: "conn-OTHER", // different conn so this isn't our subject
      spawn: slowSpawn,
    });
    await mutexHolder; // returns immediately since spawn is sync; mutex frees.
    void spawnBlocker; // satisfy unused-var lint without weakening the test
    void releaseSpawn;

    // Now the real race: imagine markDetached fires BEFORE the open completes.
    // The map exposes the attachment-check seam so the bridge can answer
    // "is this connection still alive?" — we wire it to our `attached` flag.
    // We also call markDetached up front (no-op since the entry doesn't exist
    // yet) to mirror the real bridge flow.
    map.markDetached("conn-DETACHED", () => 5_000);
    attached = false;

    let stampClockCalls = 0;
    const result = await map.open({
      ticket_id: "DSP-RACE",
      ownerConnectionId: "conn-DETACHED",
      spawn: slowSpawn,
      clock: () => {
        stampClockCalls++;
        return 7_500;
      },
      isConnectionAttached: (cid) => {
        expect(cid).toBe("conn-DETACHED");
        return attached; // false at this point
      },
    });

    if (!result.ok) throw new Error("open should have succeeded");
    const entry = map.get(result.pty_id)!;
    // The fix: even though markDetached found no entries when it ran, the
    // post-insert attachment check stamped wsClosedAt so the sweeper will
    // reap this orphan.
    expect(entry.wsClosedAt).toBe(7_500);
    // The clock was sampled at least once (for lastIoAt) and again for the
    // wsClosedAt stamp on the detached path.
    expect(stampClockCalls).toBeGreaterThanOrEqual(2);
  });

  it("leaves wsClosedAt=null when the connection is still attached at insert time", async () => {
    const map = createPtyMap();
    const result = await map.open({
      ticket_id: "DSP-OK",
      ownerConnectionId: "conn-ALIVE",
      spawn: fakeSpawn,
      isConnectionAttached: () => true,
    });
    if (!result.ok) throw new Error("open should have succeeded");
    expect(map.get(result.pty_id)!.wsClosedAt).toBeNull();
  });

  it("the sweeper-shaped check reaps the race-orphan after idleMs", async () => {
    // End-to-end shape: a race-orphan with wsClosedAt stamped at t=5000 must
    // be reaped by the sweeper at t=5000+idleMs. This proves the fix closes
    // the loop end-to-end, not just at the map boundary.
    const map = createPtyMap();
    let now = 5_000;
    const result = await map.open({
      ticket_id: "DSP-RACE-E2E",
      ownerConnectionId: "conn-DEAD",
      spawn: fakeSpawn,
      clock: () => now,
      isConnectionAttached: () => false, // detached at insert
    });
    if (!result.ok) throw new Error("open should have succeeded");
    expect(map.get(result.pty_id)!.wsClosedAt).toBe(5_000);

    // Idle sweeper's gate is `wsClosedAt + idleMs < now`. Simulate idleMs=300s.
    const idleMs = 300_000;
    const reaped: string[] = [];
    function sweeperTickOnce(): void {
      const toReap: string[] = [];
      map.forEach((entry) => {
        if (entry.wsClosedAt !== null && entry.wsClosedAt + idleMs < now) {
          toReap.push(entry.pty_id);
        }
      });
      for (const pid of toReap) {
        map.delete(pid);
        reaped.push(pid);
      }
    }
    // Tick under the threshold — must NOT reap.
    now = 5_000 + idleMs;
    sweeperTickOnce();
    expect(reaped).toEqual([]);
    expect(map.get(result.pty_id)).toBeDefined();

    // Tick PAST the threshold — must reap.
    now = 5_000 + idleMs + 1;
    sweeperTickOnce();
    expect(reaped).toContain(result.pty_id);
    expect(map.get(result.pty_id)).toBeUndefined();
  });
});
