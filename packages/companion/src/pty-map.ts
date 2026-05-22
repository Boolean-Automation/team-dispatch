/**
 * dispatch Companion — multi-PTY session registry (Phase 2).
 *
 * A singleton in-memory map keyed `${ticket_id}::${pty_id}`. Owns:
 *   - the per-ticket PTY cap (default 3, see MAX_PTYS_PER_TICKET) enforced
 *     atomically via a `p-limit(1)` per-ticket mutex so two concurrent
 *     `pty.open` frames cannot both squeeze past the cap;
 *   - per-frame OWNERSHIP authorization (Codex F2): every write/resize/close
 *     checks `entry.ownerConnectionId === connectionId` and rejects with
 *     `{ ok: false, error: 'not-authed' }` on mismatch — a token minted for
 *     one connection cannot drive another connection's PTYs;
 *   - per-entry `lastIoAt` and `wsClosedAt` timestamps the idle sweeper reads;
 *   - lookup helpers used by `bridge.ts` (entriesForConnection,
 *     entriesForTicket, entriesAttachedToWs) and the sweeper
 *     (forEachAttached).
 *
 * `pty_id` is a server-minted ULID — the client never supplies it. ULIDs are
 * lexicographically sortable and time-ordered which makes "find the newest
 * partition" trivial for the scrollback-restore replay on Companion-restart.
 *
 * The map is module-singleton (one Companion process = one registry). Tests
 * may construct a fresh map via `createPtyMap()` for isolation.
 */

import pLimit from "p-limit";
import { ulid } from "ulid";
import type { PtySession } from "./pty-session.js";

/** Default per-ticket cap (overridable via `config.MAX_PTYS_PER_TICKET`). */
export const MAX_PTYS_PER_TICKET_DEFAULT = 3;

/** A live entry in the registry. */
export interface PtyMapEntry {
  /** ULID minted on pty.open. */
  pty_id: string;
  /** The ticket this PTY belongs to. */
  ticket_id: string;
  /** Connection that opened this PTY. Owns write/resize/close authority. */
  ownerConnectionId: string;
  /** The live PtySession (the node-pty wrapper). */
  session: PtySession;
  /** Wall-clock of most recent pty.data / pty.write. */
  lastIoAt: number;
  /**
   * Wall-clock of when the owning connection's WS dropped. `null` while a
   * live WS is attached. The idle sweeper only reaps entries with
   * `wsClosedAt !== null && wsClosedAt + idleMs < now`.
   */
  wsClosedAt: number | null;
}

/** Result of an authorization-checked operation. */
export type AuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "not-authed" | "unknown-pty" };

/** Result of `open()`. */
export type OpenResult =
  | { ok: true; pty_id: string }
  | { ok: false; error: "cap-exceeded" };

/** Factory function signature — lets bridge inject its real PtySession spawn. */
export type PtySessionFactory = (args: {
  pty_id: string;
  ticket_id: string;
  ownerConnectionId: string;
}) => PtySession;

/** A pty-map instance. */
export interface PtyMap {
  /**
   * Atomically mint a pty_id, cap-check, and open a PTY for `ticket_id`.
   * Returns `cap-exceeded` when this ticket already has >= cap entries.
   * The cap-check + insert is mutex-bounded per ticket.
   */
  open(args: {
    ticket_id: string;
    ownerConnectionId: string;
    spawn: PtySessionFactory;
    clock?: () => number;
  }): Promise<OpenResult>;

  /**
   * Write `data` to the PTY identified by `pty_id`. Per-frame ownership check.
   */
  write(
    pty_id: string,
    data: string,
    connectionId: string,
    clock?: () => number
  ): AuthResult<void>;

  /**
   * Resize the PTY identified by `pty_id`. Per-frame ownership check.
   */
  resize(
    pty_id: string,
    cols: number,
    rows: number,
    connectionId: string
  ): AuthResult<void>;

  /**
   * Close (graceful SIGHUP + reap) the PTY identified by `pty_id`. Per-frame
   * ownership check. Removes the entry from the map.
   */
  close(pty_id: string, connectionId: string): AuthResult<void>;

  /** Look up an entry by `pty_id`. */
  get(pty_id: string): PtyMapEntry | undefined;

  /** All entries for a ticket. */
  entriesForTicket(ticket_id: string): PtyMapEntry[];

  /** All entries owned by a connection. */
  entriesForConnection(connectionId: string): PtyMapEntry[];

  /** All entries with a live WS (wsClosedAt === null). */
  entriesAttachedToWs(): PtyMapEntry[];

  /** Count of currently-alive entries (the `companion_ptys_active` gauge). */
  countActive(): number;

  /**
   * Stamp `wsClosedAt = clock()` on every entry owned by `connectionId`. The
   * sweeper then takes over after `idleMs`.
   */
  markDetached(connectionId: string, clock?: () => number): void;

  /** Walk every entry currently attached to a live WS. */
  forEachAttached(cb: (entry: PtyMapEntry) => void): void;

  /** Remove an entry — the sweeper calls this after the process-group kill. */
  delete(pty_id: string): void;

  /**
   * For tests / metrics: walk every entry regardless of attachment state.
   */
  forEach(cb: (entry: PtyMapEntry) => void): void;
}

export interface CreatePtyMapOptions {
  /** Override the per-ticket cap. */
  maxPtysPerTicket?: number;
}

/** Build a fresh PtyMap instance — module singleton in production, fresh per test. */
export function createPtyMap(opts: CreatePtyMapOptions = {}): PtyMap {
  const cap = opts.maxPtysPerTicket ?? MAX_PTYS_PER_TICKET_DEFAULT;
  const entries = new Map<string, PtyMapEntry>();
  const perTicketLocks = new Map<string, ReturnType<typeof pLimit>>();

  function ticketLock(ticket_id: string): ReturnType<typeof pLimit> {
    let lock = perTicketLocks.get(ticket_id);
    if (!lock) {
      lock = pLimit(1);
      perTicketLocks.set(ticket_id, lock);
    }
    return lock;
  }

  function countForTicket(ticket_id: string): number {
    let n = 0;
    for (const entry of entries.values()) {
      if (entry.ticket_id === ticket_id) n++;
    }
    return n;
  }

  return {
    async open({ ticket_id, ownerConnectionId, spawn, clock }): Promise<OpenResult> {
      const now = (clock ?? Date.now)();
      const lock = ticketLock(ticket_id);
      return lock(async () => {
        if (countForTicket(ticket_id) >= cap) {
          return { ok: false, error: "cap-exceeded" as const };
        }
        const pty_id = ulid();
        const session = spawn({ pty_id, ticket_id, ownerConnectionId });
        const entry: PtyMapEntry = {
          pty_id,
          ticket_id,
          ownerConnectionId,
          session,
          lastIoAt: now,
          wsClosedAt: null,
        };
        entries.set(pty_id, entry);
        return { ok: true, pty_id };
      });
    },

    write(pty_id, data, connectionId, clock) {
      const entry = entries.get(pty_id);
      if (!entry) return { ok: false, error: "unknown-pty" };
      if (entry.ownerConnectionId !== connectionId) {
        return { ok: false, error: "not-authed" };
      }
      entry.session.write(data);
      entry.lastIoAt = (clock ?? Date.now)();
      return { ok: true, value: undefined };
    },

    resize(pty_id, cols, rows, connectionId) {
      const entry = entries.get(pty_id);
      if (!entry) return { ok: false, error: "unknown-pty" };
      if (entry.ownerConnectionId !== connectionId) {
        return { ok: false, error: "not-authed" };
      }
      entry.session.resize(cols, rows);
      return { ok: true, value: undefined };
    },

    close(pty_id, connectionId) {
      const entry = entries.get(pty_id);
      if (!entry) return { ok: false, error: "unknown-pty" };
      if (entry.ownerConnectionId !== connectionId) {
        return { ok: false, error: "not-authed" };
      }
      entry.session.kill();
      entries.delete(pty_id);
      return { ok: true, value: undefined };
    },

    get(pty_id) {
      return entries.get(pty_id);
    },

    entriesForTicket(ticket_id) {
      const out: PtyMapEntry[] = [];
      for (const entry of entries.values()) {
        if (entry.ticket_id === ticket_id) out.push(entry);
      }
      return out;
    },

    entriesForConnection(connectionId) {
      const out: PtyMapEntry[] = [];
      for (const entry of entries.values()) {
        if (entry.ownerConnectionId === connectionId) out.push(entry);
      }
      return out;
    },

    entriesAttachedToWs() {
      const out: PtyMapEntry[] = [];
      for (const entry of entries.values()) {
        if (entry.wsClosedAt === null) out.push(entry);
      }
      return out;
    },

    countActive() {
      return entries.size;
    },

    markDetached(connectionId, clock) {
      const now = (clock ?? Date.now)();
      for (const entry of entries.values()) {
        if (entry.ownerConnectionId === connectionId && entry.wsClosedAt === null) {
          entry.wsClosedAt = now;
        }
      }
    },

    forEachAttached(cb) {
      for (const entry of entries.values()) {
        if (entry.wsClosedAt === null) cb(entry);
      }
    },

    delete(pty_id) {
      entries.delete(pty_id);
    },

    forEach(cb) {
      for (const entry of entries.values()) cb(entry);
    },
  };
}

// ── Module singleton — the production registry ──────────────────────────────

let _singleton: PtyMap | undefined;

/** Get the process-wide registry, lazy-constructed on first call. */
export function getPtyMap(opts: CreatePtyMapOptions = {}): PtyMap {
  if (!_singleton) _singleton = createPtyMap(opts);
  return _singleton;
}

/** Test-only: replace the module singleton with a fresh map. */
export function _resetPtyMap(): void {
  _singleton = undefined;
}
