// dispatch — scrollback-store tests (Phase 2 / Slice 2).
//
// Exercises the IndexedDB scrollback wrapper through its public interface only:
//   - append + getRecent round-trip
//   - eviction policy (closed-first, then open LRU, under 50 MB budget)
//   - markTicketClosed + dropClosedOlderThan
//   - rekeyForward (Companion-restart semantics — plan §S1)
//
// Uses `fake-indexeddb/auto` to give jsdom a real IndexedDB. Each test resets
// the store via the `__forTest` escape hatch so DB state never leaks.

import "fake-indexeddb/auto";
import { describe, expect, beforeEach, it } from "vitest";

import { scrollbackStore } from "./scrollback-store.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}
function decode(buf: Uint8Array): string {
  return dec.decode(buf);
}

describe("scrollbackStore", () => {
  beforeEach(async () => {
    await scrollbackStore.__forTest.reset();
  });

  it("append + getRecent round-trips a single chunk", async () => {
    await scrollbackStore.append("DSP-1", "pty-a", bytes("hello world"));
    const got = await scrollbackStore.getRecent("DSP-1", "pty-a");
    expect(decode(got)).toBe("hello world");
  });

  it("getRecent returns chunks in seq order, concatenated", async () => {
    await scrollbackStore.append("DSP-1", "pty-a", bytes("chunk-1 "));
    await scrollbackStore.append("DSP-1", "pty-a", bytes("chunk-2 "));
    await scrollbackStore.append("DSP-1", "pty-a", bytes("chunk-3"));

    const got = await scrollbackStore.getRecent("DSP-1", "pty-a");
    expect(decode(got)).toBe("chunk-1 chunk-2 chunk-3");
  });

  it("getRecent returns an empty Uint8Array when no data exists", async () => {
    const got = await scrollbackStore.getRecent("DSP-empty", "pty-x");
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got.length).toBe(0);
  });

  it("scopes by (ticket, pty) — different keys don't bleed", async () => {
    await scrollbackStore.append("DSP-1", "pty-a", bytes("aaa"));
    await scrollbackStore.append("DSP-1", "pty-b", bytes("bbb"));
    await scrollbackStore.append("DSP-2", "pty-a", bytes("222"));

    expect(decode(await scrollbackStore.getRecent("DSP-1", "pty-a"))).toBe("aaa");
    expect(decode(await scrollbackStore.getRecent("DSP-1", "pty-b"))).toBe("bbb");
    expect(decode(await scrollbackStore.getRecent("DSP-2", "pty-a"))).toBe("222");
  });

  it("getRecent caps at maxBytes from the most-recent end", async () => {
    // 3 chunks of 100 bytes each → 300 total; cap at 250 should drop the
    // oldest 50 bytes (i.e. return the trailing 250 — 50 a's + 100 b's + 100 c's).
    await scrollbackStore.append("DSP-1", "pty-a", bytes("a".repeat(100)));
    await scrollbackStore.append("DSP-1", "pty-a", bytes("b".repeat(100)));
    await scrollbackStore.append("DSP-1", "pty-a", bytes("c".repeat(100)));

    const got = await scrollbackStore.getRecent("DSP-1", "pty-a", 250);
    expect(got.length).toBe(250);
    // The tail must end with all 100 c's; the head should be the partial a-tail.
    expect(decode(got).endsWith("c".repeat(100))).toBe(true);
    expect(decode(got)).toBe(
      "a".repeat(50) + "b".repeat(100) + "c".repeat(100)
    );
  });

  it("markTicketClosed stamps closedAt on every chunk for that ticket", async () => {
    await scrollbackStore.append("DSP-1", "pty-a", bytes("first"));
    await scrollbackStore.append("DSP-1", "pty-b", bytes("second"));
    await scrollbackStore.append("DSP-2", "pty-a", bytes("other"));

    await scrollbackStore.markTicketClosed("DSP-1");

    // Round-trip via the DB directly via __forTest.getDb.
    const db = await scrollbackStore.__forTest.getDb();
    const all = await db.getAll("chunks");
    const dsp1 = all.filter((r) => r.ticket_id === "DSP-1");
    const dsp2 = all.filter((r) => r.ticket_id === "DSP-2");
    for (const row of dsp1) expect(row.closed_at).not.toBeNull();
    for (const row of dsp2) expect(row.closed_at).toBeNull();
  });

  it("dropClosedOlderThan deletes only old, closed chunks", async () => {
    await scrollbackStore.append("DSP-1", "pty-a", bytes("aaa"));
    await scrollbackStore.append("DSP-2", "pty-a", bytes("bbb"));

    await scrollbackStore.markTicketClosed("DSP-1");

    // Backdate DSP-1's closed_at to 10 days ago.
    const tenDaysAgo = Date.now() - 10 * 24 * 3600 * 1000;
    {
      const db = await scrollbackStore.__forTest.getDb();
      const tx = db.transaction("chunks", "readwrite");
      const all = await tx.store.getAll();
      for (const row of all) {
        if (row.ticket_id === "DSP-1") {
          row.closed_at = tenDaysAgo;
          await tx.store.put(row);
        }
      }
      await tx.done;
    }

    // Drop anything closed >7 days ago.
    await scrollbackStore.dropClosedOlderThan(7 * 24 * 3600 * 1000);

    // DSP-1 should be gone.
    expect(
      decode(await scrollbackStore.getRecent("DSP-1", "pty-a"))
    ).toBe("");
    // DSP-2 should be intact.
    expect(decode(await scrollbackStore.getRecent("DSP-2", "pty-a"))).toBe(
      "bbb"
    );
  });

  it("eviction prefers closed-ticket chunks (oldest closedAt first)", async () => {
    // Set a small byte budget to force eviction on small inputs.
    await scrollbackStore.__forTest.setByteBudget(120);

    // 60-byte chunks; 3 of them = 180 bytes total — over 120 budget.
    await scrollbackStore.append(
      "DSP-A",
      "pty-1",
      bytes("a".repeat(60))
    );
    await scrollbackStore.append(
      "DSP-B",
      "pty-1",
      bytes("b".repeat(60))
    );

    // Close DSP-A so it becomes the eviction target. Backdate its closed_at
    // so it is unambiguously the oldest closed.
    await scrollbackStore.markTicketClosed("DSP-A");
    {
      const db = await scrollbackStore.__forTest.getDb();
      const tx = db.transaction("chunks", "readwrite");
      const all = await tx.store.getAll();
      for (const row of all) {
        if (row.ticket_id === "DSP-A") {
          row.closed_at = 1_000;
          await tx.store.put(row);
        }
      }
      await tx.done;
    }

    // The third write tips us over budget; eviction must drop DSP-A first.
    await scrollbackStore.append(
      "DSP-C",
      "pty-1",
      bytes("c".repeat(60))
    );

    expect(decode(await scrollbackStore.getRecent("DSP-A", "pty-1"))).toBe("");
    expect(decode(await scrollbackStore.getRecent("DSP-B", "pty-1"))).toBe(
      "b".repeat(60)
    );
    expect(decode(await scrollbackStore.getRecent("DSP-C", "pty-1"))).toBe(
      "c".repeat(60)
    );
  });

  it("eviction falls back to oldest-open-by-writtenAt when no closed chunks exist", async () => {
    await scrollbackStore.__forTest.setByteBudget(120);

    // No tickets are closed.
    await scrollbackStore.append(
      "DSP-X",
      "pty-1",
      bytes("x".repeat(60))
    );
    // Small sleep so written_at differs.
    await new Promise((r) => setTimeout(r, 5));
    await scrollbackStore.append(
      "DSP-Y",
      "pty-1",
      bytes("y".repeat(60))
    );
    await new Promise((r) => setTimeout(r, 5));
    await scrollbackStore.append(
      "DSP-Z",
      "pty-1",
      bytes("z".repeat(60))
    );

    // DSP-X is the oldest open and should have been evicted first.
    expect(decode(await scrollbackStore.getRecent("DSP-X", "pty-1"))).toBe("");
    expect(decode(await scrollbackStore.getRecent("DSP-Y", "pty-1"))).toBe(
      "y".repeat(60)
    );
    expect(decode(await scrollbackStore.getRecent("DSP-Z", "pty-1"))).toBe(
      "z".repeat(60)
    );
  });

  it("rekeyForward copies data from old_pty_id → new_pty_id and drops the old", async () => {
    await scrollbackStore.append("DSP-1", "old-pty", bytes("preserved"));

    await scrollbackStore.rekeyForward("DSP-1", "old-pty", "new-pty");

    expect(decode(await scrollbackStore.getRecent("DSP-1", "new-pty"))).toBe(
      "preserved"
    );
    expect(decode(await scrollbackStore.getRecent("DSP-1", "old-pty"))).toBe(
      ""
    );
  });

  // ── P2-1 fix (gate-review.md) — concurrent appends transact correctly ─────
  //
  // Two concurrent appends from opener + popout on the same (ticket, pty)
  // pre-fix interleaved: A read-meta, B read-meta, A put-chunk, A write-meta
  // (X bytes), B put-chunk, B write-meta (X bytes — should be X+B). The
  // running total lost bytes from the accounting. Post-fix, each append's
  // RMW is one IDB transaction so the second reads the first's committed
  // meta.

  it("P2-1: concurrent appends on the same (ticket, pty) accumulate bytes correctly", async () => {
    const a = "a".repeat(2000);
    const b = "b".repeat(2000);

    await Promise.all([
      scrollbackStore.append("DSP-CONC", "pty-1", bytes(a)),
      scrollbackStore.append("DSP-CONC", "pty-1", bytes(b)),
    ]);

    // Both chunks must persist.
    const got = await scrollbackStore.getRecent("DSP-CONC", "pty-1");
    expect(got.length).toBe(a.length + b.length);

    // The meta.totalBytes must equal the sum of all chunks (no drops).
    const db = await scrollbackStore.__forTest.getDb();
    const meta = await db.get("meta", "meta");
    expect(meta).toBeDefined();
    expect(meta!.totalBytes).toBe(a.length + b.length);
  });

  it("P2-1: many concurrent appends on the same (ticket, pty) — totalBytes stays exact", async () => {
    // Stress: 10 concurrent appends, 500 bytes each.
    const chunks = Array.from({ length: 10 }, (_, i) =>
      String.fromCharCode(97 + i).repeat(500)
    );

    await Promise.all(
      chunks.map((c) => scrollbackStore.append("DSP-STRESS", "pty-1", bytes(c)))
    );

    const expectedTotal = chunks.reduce((sum, c) => sum + c.length, 0);
    const db = await scrollbackStore.__forTest.getDb();
    const meta = await db.get("meta", "meta");
    expect(meta!.totalBytes).toBe(expectedTotal);

    const got = await scrollbackStore.getRecent("DSP-STRESS", "pty-1");
    expect(got.length).toBe(expectedTotal);
  });
});
