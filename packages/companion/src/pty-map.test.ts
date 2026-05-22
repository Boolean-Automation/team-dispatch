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
