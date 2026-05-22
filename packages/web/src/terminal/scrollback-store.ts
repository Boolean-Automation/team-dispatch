// dispatch — IndexedDB scrollback store (Phase 2 / Slice 2).
//
// Persists xterm scrollback bytes per (ticket_id, pty_id) so a re-opened panel
// can replay the SE's history before live frames arrive. Plan §S2:
//   - append(ticket_id, pty_id, bytes): writes a new chunk; bumps totalBytes;
//     evicts under a 50 MB budget if needed.
//   - getRecent(ticket_id, pty_id, maxBytes?): concatenates chunks in seq order
//     and returns the trailing `maxBytes` (or all of it if smaller).
//   - markTicketClosed(ticket_id): stamps closed_at on every chunk for the
//     ticket. Drives the OQ-5 ticket-closed eviction primary.
//   - dropClosedOlderThan(ageMs): garbage-collects chunks whose ticket has been
//     closed for > ageMs (default 7 days).
//   - rekeyForward(ticket_id, old_pty_id, new_pty_id): plan §S1 Companion-
//     restart semantics — copy a partition forward, drop the old.
//
// Eviction order (OQ-5 + plan §S2):
//   1. closed-ticket chunks, oldest-by-closed_at first.
//   2. open-ticket chunks, oldest-by-written_at second.
//
// `__forTest` is a small escape hatch the test file uses to reset state and
// shrink the byte budget. NOT exported from index.ts — production code never
// touches it.

import { openDB, type IDBPDatabase, type DBSchema } from "idb";

/** A persisted chunk row. One per `append` call. */
export interface ChunkRow {
  /** Composite primary key: `${ticket_id}::${pty_id}::${seq}`. */
  key: string;
  ticket_id: string;
  pty_id: string;
  /** Monotonic per-(ticket, pty) sequence number. */
  seq: number;
  bytes: Uint8Array;
  written_at: number;
  /** Stamped by `markTicketClosed`. Null while the ticket is still open. */
  closed_at: number | null;
  /** Byte length of `bytes`, kept on the row for cheap budget math. */
  size_bytes: number;
}

/** The meta singleton row. One per DB. */
export interface MetaRow {
  id: "meta";
  totalBytes: number;
  byteBudget: number;
  /** Per-(ticket, pty) seq counter, persisted so it survives reloads. */
  seqByKey: Record<string, number>;
}

interface ScrollbackSchema extends DBSchema {
  chunks: {
    key: string;
    value: ChunkRow;
    indexes: {
      byTicketPty: [string, string, number];
      byClosedAt: number;
      byWrittenAt: number;
    };
  };
  meta: {
    key: string;
    value: MetaRow;
  };
}

const DB_NAME = "dispatch-terminal-scrollback";
const DB_VERSION = 1;
const DEFAULT_BYTE_BUDGET = 50 * 1024 * 1024; // 50 MB
const DEFAULT_GET_RECENT_MAX = 10 * 1024 * 1024; // 10 MB
const DEFAULT_CLOSED_AGE_MS = 7 * 24 * 3600 * 1000; // 7 days

/** Helper: composite key for a chunk row. */
function makeKey(ticket_id: string, pty_id: string, seq: number): string {
  // Zero-pad seq to keep lexicographic order == numeric order, so the index
  // scan returns chunks in seq order without an extra sort.
  return `${ticket_id}::${pty_id}::${seq.toString().padStart(12, "0")}`;
}

/** Helper: meta seq key. */
function seqKey(ticket_id: string, pty_id: string): string {
  return `${ticket_id}::${pty_id}`;
}

let dbPromise: Promise<IDBPDatabase<ScrollbackSchema>> | null = null;

async function getDb(): Promise<IDBPDatabase<ScrollbackSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<ScrollbackSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const chunks = db.createObjectStore("chunks", { keyPath: "key" });
        chunks.createIndex("byTicketPty", ["ticket_id", "pty_id", "seq"]);
        chunks.createIndex("byClosedAt", "closed_at");
        chunks.createIndex("byWrittenAt", "written_at");
        db.createObjectStore("meta", { keyPath: "id" });
      },
    });
  }
  return dbPromise;
}

async function readMeta(
  db: IDBPDatabase<ScrollbackSchema>
): Promise<MetaRow> {
  const row = await db.get("meta", "meta");
  if (row) return row;
  return {
    id: "meta",
    totalBytes: 0,
    byteBudget: DEFAULT_BYTE_BUDGET,
    seqByKey: {},
  };
}

async function writeMeta(
  db: IDBPDatabase<ScrollbackSchema>,
  meta: MetaRow
): Promise<void> {
  await db.put("meta", meta);
}

/**
 * Evict chunks until totalBytes is at or under the budget. Closed-ticket
 * chunks go first (oldest closed_at first); then open-ticket chunks (oldest
 * written_at). Mutates `meta.totalBytes` in place.
 */
async function evictUntilUnderBudget(
  db: IDBPDatabase<ScrollbackSchema>,
  meta: MetaRow
): Promise<void> {
  if (meta.totalBytes <= meta.byteBudget) return;

  // Phase 1: closed-ticket chunks, oldest closed_at first.
  // Iterate via the byClosedAt index — null values are excluded by IDB ranges,
  // so we get only closed rows.
  let cursor = await db
    .transaction("chunks", "readonly")
    .store.index("byClosedAt")
    .openCursor();
  const closedKeys: { key: string; size: number; closed_at: number }[] = [];
  while (cursor) {
    const row = cursor.value;
    if (row.closed_at !== null) {
      closedKeys.push({
        key: row.key,
        size: row.size_bytes,
        closed_at: row.closed_at,
      });
    }
    cursor = await cursor.continue();
  }
  closedKeys.sort((a, b) => a.closed_at - b.closed_at);

  for (const ck of closedKeys) {
    if (meta.totalBytes <= meta.byteBudget) break;
    await db.delete("chunks", ck.key);
    meta.totalBytes -= ck.size;
  }
  if (meta.totalBytes <= meta.byteBudget) return;

  // Phase 2: open-ticket chunks, oldest written_at first.
  let openCursor = await db
    .transaction("chunks", "readonly")
    .store.index("byWrittenAt")
    .openCursor();
  const openKeys: { key: string; size: number; written_at: number }[] = [];
  while (openCursor) {
    const row = openCursor.value;
    if (row.closed_at === null) {
      openKeys.push({
        key: row.key,
        size: row.size_bytes,
        written_at: row.written_at,
      });
    }
    openCursor = await openCursor.continue();
  }
  openKeys.sort((a, b) => a.written_at - b.written_at);

  for (const ok of openKeys) {
    if (meta.totalBytes <= meta.byteBudget) break;
    await db.delete("chunks", ok.key);
    meta.totalBytes -= ok.size;
  }
}

/**
 * Append a chunk of bytes for (ticket_id, pty_id). Bumps the running total
 * and triggers eviction if the byte budget is exceeded.
 *
 * P2-1 fix (gate-review.md): the read-meta → put-chunk → write-meta sequence
 * is wrapped in a SINGLE IDB transaction so concurrent appends from opener +
 * popout (both writing the same `(ticket, pty)`) can no longer interleave:
 *   pre-fix:  A read-meta, B read-meta, A put-chunk, A write-meta (X bytes),
 *             B put-chunk, B write-meta (X bytes — should be X+B) → bytes
 *             dropped from the running total, eviction misfires.
 *   post-fix: each append owns the chunks+meta stores for the full RMW. The
 *             second concurrent append's `readMeta` reads the value the
 *             first append's `writeMeta` already committed, so totalBytes
 *             accumulates correctly.
 *
 * Eviction (a multi-cursor walk) stays OUTSIDE the append transaction —
 * doing eviction inside the same tx would tie up the chunks store for
 * potentially many MB of cursor work, blocking other transactions. The
 * trade is that eviction can momentarily over-shoot the budget; that's
 * acceptable because the budget itself is a soft target.
 */
async function append(
  ticket_id: string,
  pty_id: string,
  bytes: Uint8Array
): Promise<void> {
  if (bytes.length === 0) return;
  const db = await getDb();

  // Copy the bytes — Uint8Array views over a shared buffer leak surprises.
  const bytesCopy = new Uint8Array(bytes);

  // P2-1: single transaction across chunks + meta. The tx serializes the
  // RMW so a concurrent append on the same (ticket, pty) sees our committed
  // meta before issuing its own read.
  const tx = db.transaction(["chunks", "meta"], "readwrite");
  const chunksStore = tx.objectStore("chunks");
  const metaStore = tx.objectStore("meta");

  const metaRaw = await metaStore.get("meta");
  const meta: MetaRow = metaRaw ?? {
    id: "meta",
    totalBytes: 0,
    byteBudget: DEFAULT_BYTE_BUDGET,
    seqByKey: {},
  };

  const sKey = seqKey(ticket_id, pty_id);
  const nextSeq = (meta.seqByKey[sKey] ?? 0) + 1;
  meta.seqByKey[sKey] = nextSeq;

  const row: ChunkRow = {
    key: makeKey(ticket_id, pty_id, nextSeq),
    ticket_id,
    pty_id,
    seq: nextSeq,
    bytes: bytesCopy,
    written_at: Date.now(),
    closed_at: null,
    size_bytes: bytesCopy.length,
  };
  await chunksStore.put(row);

  meta.totalBytes += bytesCopy.length;
  await metaStore.put(meta);
  await tx.done;

  // Eviction is intentionally OUTSIDE the append transaction (see jsdoc
  // above). The post-eviction meta is committed in a separate write.
  if (meta.totalBytes > meta.byteBudget) {
    const evictMeta = (await readMeta(db));
    await evictUntilUnderBudget(db, evictMeta);
    await writeMeta(db, evictMeta);
  }
}

/**
 * Read the most recent `maxBytes` of scrollback for (ticket_id, pty_id),
 * concatenated in seq order. Returns an empty Uint8Array when no data exists.
 */
async function getRecent(
  ticket_id: string,
  pty_id: string,
  maxBytes: number = DEFAULT_GET_RECENT_MAX
): Promise<Uint8Array> {
  const db = await getDb();

  // Scan the byTicketPty index for this (ticket, pty), seq ascending.
  const rows: ChunkRow[] = [];
  let cursor = await db
    .transaction("chunks", "readonly")
    .store.index("byTicketPty")
    .openCursor(
      IDBKeyRange.bound(
        [ticket_id, pty_id, 0],
        [ticket_id, pty_id, Number.MAX_SAFE_INTEGER]
      )
    );
  while (cursor) {
    rows.push(cursor.value);
    cursor = await cursor.continue();
  }
  if (rows.length === 0) return new Uint8Array(0);

  // Compute total and decide how much of the tail to keep.
  const totalBytes = rows.reduce((acc, r) => acc + r.size_bytes, 0);
  if (totalBytes <= maxBytes) {
    return concat(rows.map((r) => r.bytes), totalBytes);
  }
  // Walk from the tail backwards collecting until we exceed maxBytes; then
  // slice the head chunk down to the remainder.
  let kept = 0;
  const tail: Uint8Array[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (kept + row.size_bytes <= maxBytes) {
      tail.unshift(row.bytes);
      kept += row.size_bytes;
      continue;
    }
    const remainder = maxBytes - kept;
    if (remainder > 0) {
      tail.unshift(row.bytes.subarray(row.size_bytes - remainder));
      kept += remainder;
    }
    break;
  }
  return concat(tail, kept);
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Stamp `closed_at = now()` on every chunk for `ticket_id`. The OQ-5 primary
 * eviction signal — closed-ticket chunks become the first eviction candidate.
 */
async function markTicketClosed(ticket_id: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  const tx = db.transaction("chunks", "readwrite");
  let cursor = await tx.store.openCursor();
  while (cursor) {
    const row = cursor.value;
    if (row.ticket_id === ticket_id && row.closed_at === null) {
      row.closed_at = now;
      await cursor.update(row);
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Delete chunks where `closed_at && (now - closed_at) > ageMs`. */
async function dropClosedOlderThan(
  ageMs: number = DEFAULT_CLOSED_AGE_MS
): Promise<void> {
  const db = await getDb();
  const cutoff = Date.now() - ageMs;
  const meta = await readMeta(db);

  const tx = db.transaction("chunks", "readwrite");
  let cursor = await tx.store.openCursor();
  while (cursor) {
    const row = cursor.value;
    if (row.closed_at !== null && row.closed_at < cutoff) {
      meta.totalBytes -= row.size_bytes;
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  await writeMeta(db, meta);
}

/**
 * Plan §S1 Companion-restart semantics: copy every chunk for
 * (ticket_id, old_pty_id) → new_pty_id and drop the old partition. Used when
 * `companion_started_at` flips and the cached pty_id is no longer valid.
 */
async function rekeyForward(
  ticket_id: string,
  old_pty_id: string,
  new_pty_id: string
): Promise<void> {
  if (old_pty_id === new_pty_id) return;
  const db = await getDb();
  const meta = await readMeta(db);

  // Walk old chunks; copy to new keys, delete old.
  const tx = db.transaction("chunks", "readwrite");
  let cursor = await tx.store
    .index("byTicketPty")
    .openCursor(
      IDBKeyRange.bound(
        [ticket_id, old_pty_id, 0],
        [ticket_id, old_pty_id, Number.MAX_SAFE_INTEGER]
      )
    );
  while (cursor) {
    const row = cursor.value;
    const newRow: ChunkRow = {
      ...row,
      pty_id: new_pty_id,
      key: makeKey(ticket_id, new_pty_id, row.seq),
    };
    await tx.store.put(newRow);
    await tx.store.delete(row.key);
    cursor = await cursor.continue();
  }
  await tx.done;

  // Migrate the seqByKey counter so subsequent appends continue numbering.
  const oldSeqKey = seqKey(ticket_id, old_pty_id);
  const newSeqKey = seqKey(ticket_id, new_pty_id);
  if (meta.seqByKey[oldSeqKey] !== undefined) {
    meta.seqByKey[newSeqKey] = Math.max(
      meta.seqByKey[newSeqKey] ?? 0,
      meta.seqByKey[oldSeqKey]
    );
    delete meta.seqByKey[oldSeqKey];
  }
  await writeMeta(db, meta);
}

/** Test-only escape hatch. NOT re-exported from index.ts. */
async function __reset(): Promise<void> {
  // Close + delete the DB and clear the cached promise so the next call
  // re-opens fresh. fake-indexeddb supports deleteDatabase.
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
  }
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function __setByteBudget(bytes: number): Promise<void> {
  const db = await getDb();
  const meta = await readMeta(db);
  meta.byteBudget = bytes;
  await writeMeta(db, meta);
}

export const scrollbackStore = {
  append,
  getRecent,
  markTicketClosed,
  dropClosedOlderThan,
  rekeyForward,
  /**
   * Test-only escape hatch. Do not use from production code paths. The shape
   * is part of the test API surface only — NOT re-exported from `index.ts`.
   */
  __forTest: {
    reset: __reset,
    getDb,
    setByteBudget: __setByteBudget,
  },
};

export type ScrollbackStore = typeof scrollbackStore;
