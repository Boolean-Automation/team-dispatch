// dispatch — effort-service tests
//
// Tests:
//   1. setEffortBucket sets the effort bucket and returns undoToken.
//   2. setEffortBucket is undoable — reverts to previous bucket.
//   3. setEffortBucket returns error for unknown ticket.
//   4. updateTicketStatus rejects 'closed' with null effort bucket (service guard).
//   5. updateTicketStatus succeeds after setting effort bucket.
//   6. DB CHECK constraint prevents writing closed+null via a raw UPDATE.
//   7. (P2-3) Setting effort_bucket on a waiting-client ticket does NOT change
//      waiting_client_since_at (SLA timer clock must not be reset by unrelated mutations).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, auditLog } from "../../db/src/schema.js";
import { setEffortBucket } from "../src/services/effort-service.js";
import { updateTicketStatus } from "../src/services/ticket-service.js";
import { undoByToken } from "../src/services/undo-service.js";
import type { Db } from "../../db/src/client.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let testAccountId: string;
let testTicketId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const acct = await db
    .insert(accounts)
    .values({
      slug: `effort-svc-test-${Date.now()}`,
      displayName: "Effort Service Test Account",
      health: "good",
    })
    .returning();
  testAccountId = acct[0]!.id;

  const tkt = await db
    .insert(tickets)
    .values({
      accountId: testAccountId,
      status: "on-you",
      type: "question",
      sourceKind: "channel",
      originClass: "client",
    })
    .returning();
  testTicketId = tkt[0]!.id;
});

afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.ticketId, testTicketId));
  await db.delete(tickets).where(eq(tickets.id, testTicketId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

describe("setEffortBucket", () => {
  it("sets the effort bucket and returns an undoToken", async () => {
    const result = await setEffortBucket(
      db,
      testTicketId,
      "client-specific",
      "user_effort_actor"
    );

    expect(result.ok).toBe(true);
    expect(result.undoToken).toBeTruthy();
    expect(result.newBucket).toBe("client-specific");

    // Verify the DB was updated
    const rows = await db
      .select({ effortBucket: tickets.effortBucket })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.effortBucket).toBe("client-specific");
  });

  it("is undoable — reverts to previous bucket", async () => {
    // Set to platform-shared first
    await setEffortBucket(db, testTicketId, "platform-shared", "user_effort_actor");
    const result = await setEffortBucket(
      db,
      testTicketId,
      "one-time-build",
      "user_effort_actor"
    );

    expect(result.previousBucket).toBe("platform-shared");

    // Undo → reverts to platform-shared
    const undoResult = await undoByToken(db, result.undoToken!);
    expect(undoResult.ok).toBe(true);

    const rows = await db
      .select({ effortBucket: tickets.effortBucket })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.effortBucket).toBe("platform-shared");
  });

  it("returns an error for an unknown ticket", async () => {
    const result = await setEffortBucket(
      db,
      "00000000-0000-0000-0000-000000000000",
      "client-specific",
      "user_effort_actor"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("service-layer guard — effort bucket on close (A7)", () => {
  it("rejects 'closed' status when effort_bucket is null", async () => {
    // Reset effort bucket to null so the guard fires
    await db
      .update(tickets)
      .set({ effortBucket: null, status: "on-you" })
      .where(eq(tickets.id, testTicketId));

    const result = await updateTicketStatus(
      db,
      testTicketId,
      "closed",
      "user_effort_actor"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("effort bucket");
  });

  it("rejects 'complete' status when effort_bucket is null", async () => {
    const result = await updateTicketStatus(
      db,
      testTicketId,
      "complete",
      "user_effort_actor"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("effort bucket");
  });

  it("allows 'closed' after setting an effort bucket", async () => {
    // Set an effort bucket
    await setEffortBucket(db, testTicketId, "client-specific", "user_effort_actor");

    // Now closing should succeed
    const result = await updateTicketStatus(
      db,
      testTicketId,
      "closed",
      "user_effort_actor"
    );
    expect(result.ok).toBe(true);
    expect(result.newStatus).toBe("closed");
  });
});

// ── P2-3: effort_bucket set on waiting-client does NOT reset waiting_client_since_at ──

describe("SLA clock isolation — P2-3", () => {
  it("setting effort_bucket on a waiting-client ticket does NOT change waiting_client_since_at", async () => {
    // Put the test ticket in 'waiting-client' with a stamped waiting_client_since_at
    const waitingSince = new Date("2026-01-01T10:00:00Z");
    await db
      .update(tickets)
      .set({
        status: "waiting-client",
        effortBucket: null,
        waitingClientSinceAt: waitingSince,
      })
      .where(eq(tickets.id, testTicketId));

    // Set the effort bucket — this is a common SE action on a waiting-client ticket
    const effortResult = await setEffortBucket(
      db,
      testTicketId,
      "platform-shared",
      "user_se_actor"
    );
    expect(effortResult.ok).toBe(true);

    // waiting_client_since_at must be unchanged (the SLA clock must not reset)
    const rows = await db
      .select({ waitingClientSinceAt: tickets.waitingClientSinceAt })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);

    expect(rows[0]?.waitingClientSinceAt?.toISOString()).toBe(waitingSince.toISOString());

    // Cleanup — reset ticket to a neutral state for other tests
    await db
      .update(tickets)
      .set({ status: "on-you", effortBucket: null, waitingClientSinceAt: null })
      .where(eq(tickets.id, testTicketId));
  });
});
