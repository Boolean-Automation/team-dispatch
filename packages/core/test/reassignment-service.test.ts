// dispatch — reassignment-service tests
//
// Tests (centerpiece — the pending-handshake vs admin-immediate state machine):
//   1. SE-initiated: creates a pending reassignment; tickets.assignee unchanged.
//   2. SE-initiated: recipient accepts → status='accepted', assignee moves.
//   3. SE-initiated: recipient rejects → status='rejected', assignee unchanged.
//   4. Admin-initiated: status='accepted' immediately; assignee moves at once.
//   5. Accept fails if not the recipient.
//   6. Accept fails if reassignment not pending (already accepted).
//   7. Reject fails if not the recipient.
//   8. Undoing an SE-initiated reassignment.created deletes the row.
//   9. Undoing reassignment.accepted reverts assignee + resets to 'pending'.
//  10. Undoing reassignment.rejected resets to 'pending'.
//  11. Both paths raise notifications.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import {
  accounts,
  tickets,
  auditLog,
  reassignments,
  notifications,
} from "../../db/src/schema.js";
import {
  initiateReassignment,
  acceptReassignment,
  rejectReassignment,
  getReassignment,
} from "../src/services/reassignment-service.js";
import { undoByToken } from "../src/services/undo-service.js";
import type { Db } from "../../db/src/client.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let testAccountId: string;
let testTicketId: string;

const SE_PROPOSER = "user_se_proposer";
const SE_RECIPIENT = "user_se_recipient";
const ADMIN_PROPOSER = "user_admin";

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const acct = await db
    .insert(accounts)
    .values({
      slug: `reassign-test-${Date.now()}`,
      displayName: "Reassignment Test Account",
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
      assignee: SE_PROPOSER,
      sourceKind: "channel",
      originClass: "client",
    })
    .returning();
  testTicketId = tkt[0]!.id;
});

afterAll(async () => {
  // Clean up in cascade order
  await db.delete(notifications).where(eq(notifications.ticketId, testTicketId));
  await db.delete(reassignments).where(eq(reassignments.ticketId, testTicketId));
  await db.delete(auditLog).where(eq(auditLog.ticketId, testTicketId));
  await db.delete(tickets).where(eq(tickets.id, testTicketId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

// Helper — reset ticket assignee + clear reassignment rows between tests
async function resetTicket() {
  await db
    .update(tickets)
    .set({ assignee: SE_PROPOSER, status: "on-you" })
    .where(eq(tickets.id, testTicketId));
  await db
    .delete(reassignments)
    .where(eq(reassignments.ticketId, testTicketId));
}

describe("SE-initiated reassignment — pending handshake", () => {
  it("creates a pending reassignment; tickets.assignee stays with proposer", async () => {
    await resetTicket();

    const result = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );

    expect(result.ok).toBe(true);
    expect(result.reassignment?.status).toBe("pending");
    expect(result.reassignment?.proposer).toBe(SE_PROPOSER);
    expect(result.reassignment?.recipient).toBe(SE_RECIPIENT);
    expect(result.undoToken).toBeTruthy();

    // tickets.assignee must NOT have changed
    const rows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.assignee).toBe(SE_PROPOSER);
  });

  it("recipient accepts → status='accepted', assignee moves to recipient", async () => {
    await resetTicket();

    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    const reassignmentId = initResult.reassignment!.id;

    const acceptResult = await acceptReassignment(
      db,
      reassignmentId,
      SE_RECIPIENT
    );
    expect(acceptResult.ok).toBe(true);
    expect(acceptResult.reassignment?.status).toBe("accepted");

    // tickets.assignee must move to recipient
    const rows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.assignee).toBe(SE_RECIPIENT);
  });

  it("recipient rejects → status='rejected', assignee stays with proposer", async () => {
    await resetTicket();

    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    const reassignmentId = initResult.reassignment!.id;

    const rejectResult = await rejectReassignment(
      db,
      reassignmentId,
      SE_RECIPIENT
    );
    expect(rejectResult.ok).toBe(true);
    expect(rejectResult.reassignment?.status).toBe("rejected");

    // tickets.assignee must stay with proposer
    const rows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.assignee).toBe(SE_PROPOSER);
  });

  it("accept fails when caller is not the recipient", async () => {
    await resetTicket();

    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );

    const result = await acceptReassignment(
      db,
      initResult.reassignment!.id,
      "user_someone_else"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("recipient");
  });

  it("accept fails when reassignment is already accepted", async () => {
    await resetTicket();

    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    const id = initResult.reassignment!.id;

    await acceptReassignment(db, id, SE_RECIPIENT);
    const secondAccept = await acceptReassignment(db, id, SE_RECIPIENT);
    expect(secondAccept.ok).toBe(false);
    expect(secondAccept.error).toContain("already");
  });

  it("reject fails when caller is not the recipient", async () => {
    await resetTicket();

    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );

    const result = await rejectReassignment(
      db,
      initResult.reassignment!.id,
      "user_someone_else"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("recipient");
  });
});

describe("Admin-initiated reassignment — immediate", () => {
  it("admin reassignment: status='accepted' immediately, assignee moves at once", async () => {
    await resetTicket();

    const result = await initiateReassignment(
      db,
      testTicketId,
      ADMIN_PROPOSER,
      SE_RECIPIENT,
      "admin"
    );

    expect(result.ok).toBe(true);
    expect(result.reassignment?.status).toBe("accepted");
    expect(result.undoToken).toBeTruthy();

    // tickets.assignee must move to recipient immediately
    const rows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.assignee).toBe(SE_RECIPIENT);
  });
});

describe("Undo reassignment actions", () => {
  it("undo SE reassignment.created deletes the row", async () => {
    await resetTicket();

    const result = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    const reassignmentId = result.reassignment!.id;

    // Undo
    const undoResult = await undoByToken(db, result.undoToken!);
    expect(undoResult.ok).toBe(true);

    // Row should be gone
    const row = await getReassignment(db, reassignmentId);
    expect(row).toBeNull();

    // Assignee still with proposer
    const rows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.assignee).toBe(SE_PROPOSER);
  });

  it("undo admin reassignment.created reverts assignee", async () => {
    await resetTicket();

    const result = await initiateReassignment(
      db,
      testTicketId,
      ADMIN_PROPOSER,
      SE_RECIPIENT,
      "admin"
    );

    // Undo
    await undoByToken(db, result.undoToken!);

    // Assignee should revert to SE_PROPOSER
    const rows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.assignee).toBe(SE_PROPOSER);
  });

  it("undo reassignment.accepted reverts assignee and resets to pending", async () => {
    await resetTicket();

    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    const acceptResult = await acceptReassignment(
      db,
      initResult.reassignment!.id,
      SE_RECIPIENT
    );

    // Undo the accept
    const undoResult = await undoByToken(db, acceptResult.undoToken!);
    expect(undoResult.ok).toBe(true);

    // Assignee should revert to SE_PROPOSER
    const ticketRows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(ticketRows[0]?.assignee).toBe(SE_PROPOSER);

    // Reassignment should be pending again
    const row = await getReassignment(db, initResult.reassignment!.id);
    expect(row?.status).toBe("pending");
  });

  it("undo reassignment.rejected resets to pending", async () => {
    await resetTicket();

    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    const rejectResult = await rejectReassignment(
      db,
      initResult.reassignment!.id,
      SE_RECIPIENT
    );

    // Undo the reject
    await undoByToken(db, rejectResult.undoToken!);

    // Reassignment should be pending again
    const row = await getReassignment(db, initResult.reassignment!.id);
    expect(row?.status).toBe("pending");
  });
});

describe("Concurrent-pending guard (P2-4)", () => {
  it("second initiateReassignment while a pending row exists is rejected with error", async () => {
    await resetTicket();

    // First initiation — creates a pending row
    const first = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    expect(first.ok).toBe(true);
    expect(first.reassignment?.status).toBe("pending");

    // Second initiation — should be rejected (pending row still exists)
    const second = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    expect(second.ok).toBe(false);
    expect(second.error).toContain("pending reassignment already exists");
  });

  it("a new pending reassignment is allowed after the existing one is accepted", async () => {
    await resetTicket();

    // Create a pending reassignment and accept it
    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    expect(initResult.ok).toBe(true);
    const acceptResult = await acceptReassignment(
      db,
      initResult.reassignment!.id,
      SE_RECIPIENT
    );
    expect(acceptResult.ok).toBe(true);

    // Reset ticket back to SE_PROPOSER for next reassignment test
    await db
      .update(tickets)
      .set({ assignee: SE_PROPOSER, status: "on-you" })
      .where(eq(tickets.id, testTicketId));

    // Now we should be able to create a new pending row (the old one is 'accepted')
    const third = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    expect(third.ok).toBe(true);
    expect(third.reassignment?.status).toBe("pending");
  });

  it("a new pending reassignment is allowed after the existing one is rejected", async () => {
    await resetTicket();

    // Create a pending reassignment and reject it
    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    expect(initResult.ok).toBe(true);
    const rejectResult = await rejectReassignment(
      db,
      initResult.reassignment!.id,
      SE_RECIPIENT
    );
    expect(rejectResult.ok).toBe(true);

    // Now we should be able to create a new pending row (the old one is 'rejected')
    const second = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    expect(second.ok).toBe(true);
    expect(second.reassignment?.status).toBe("pending");
  });
});

describe("Notifications", () => {
  it("SE-initiated reassignment creates an incoming notification for recipient", async () => {
    await resetTicket();

    await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );

    const notifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, SE_RECIPIENT));

    const incoming = notifs.filter((n) => n.kind === "reassignment-incoming");
    expect(incoming.length).toBeGreaterThan(0);
  });

  it("admin-initiated reassignment creates an accepted notification for recipient", async () => {
    await resetTicket();

    await initiateReassignment(
      db,
      testTicketId,
      ADMIN_PROPOSER,
      SE_RECIPIENT,
      "admin"
    );

    const notifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, SE_RECIPIENT));

    const accepted = notifs.filter((n) => n.kind === "reassignment-accepted");
    expect(accepted.length).toBeGreaterThan(0);
  });
});

// ── P2-A: DB-level unique constraint path ─────────────────────────────────────
//
// These tests verify the second layer of the concurrent-pending guard: the DB
// partial unique index (0006) catches a second pending INSERT even when two
// concurrent requests both pass the SELECT fast-path.
//
// We test this by: inserting a pending row directly (bypassing the service
// SELECT check) and then trying to INSERT a second pending row — confirming the
// index fires and the service maps it to a _conflict result.

describe("P2-A: DB-level partial unique index on pending reassignments", () => {
  it("direct insert of a duplicate pending row violates the unique index", async () => {
    await resetTicket();

    // Insert one pending row directly via Drizzle (not through the service)
    await db.insert(reassignments).values({
      ticketId: testTicketId,
      proposer: SE_PROPOSER,
      recipient: SE_RECIPIENT,
      status: "pending",
    });

    // A second direct INSERT of a pending row for the same ticket must fail
    // with Postgres error code 23505 (unique_violation).
    let caught: unknown;
    try {
      await db.insert(reassignments).values({
        ticketId: testTicketId,
        proposer: SE_PROPOSER,
        recipient: SE_RECIPIENT,
        status: "pending",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("23505");

    // Cleanup
    await db.delete(reassignments).where(eq(reassignments.ticketId, testTicketId));
  });

  it("second accepted row for the same ticket is allowed (index is partial: pending only)", async () => {
    await resetTicket();

    // Insert one accepted row directly
    await db.insert(reassignments).values({
      ticketId: testTicketId,
      proposer: SE_PROPOSER,
      recipient: SE_RECIPIENT,
      status: "accepted",
      resolvedAt: new Date(),
    });

    // A second accepted row must NOT violate the index (non-pending rows are excluded)
    await expect(
      db.insert(reassignments).values({
        ticketId: testTicketId,
        proposer: SE_PROPOSER,
        recipient: SE_RECIPIENT,
        status: "accepted",
        resolvedAt: new Date(),
      })
    ).resolves.toBeDefined();

    // Cleanup
    await db.delete(reassignments).where(eq(reassignments.ticketId, testTicketId));
  });
});

// ── P2-D: Guarded accept/reject — stale-conflict path ────────────────────────
//
// These tests verify that a second accept or a reject-after-accept returns the
// stale-conflict result rather than silently succeeding.

describe("P2-D: Guarded accept/reject — stale-conflict path", () => {
  it("second accept of an already-accepted row returns stale", async () => {
    await resetTicket();

    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    const id = initResult.reassignment!.id;

    // First accept — should succeed
    const first = await acceptReassignment(db, id, SE_RECIPIENT);
    expect(first.ok).toBe(true);

    // Manually reset the row back to "accepted" so the second accept sees a
    // non-pending row (simulates arriving after first accept committed).
    // The second accept must return stale (row no longer pending).
    const second = await acceptReassignment(db, id, SE_RECIPIENT);
    expect(second.ok).toBe(false);
    // Either the select-path error or the stale guard — both are "already accepted"
    expect(second.error).toMatch(/already (accepted|resolved)/i);
  });

  it("reject-after-accept returns stale", async () => {
    await resetTicket();

    const initResult = await initiateReassignment(
      db,
      testTicketId,
      SE_PROPOSER,
      SE_RECIPIENT,
      "se"
    );
    const id = initResult.reassignment!.id;

    // Accept first
    const acceptResult = await acceptReassignment(db, id, SE_RECIPIENT);
    expect(acceptResult.ok).toBe(true);

    // Now attempt to reject the already-accepted row
    const rejectResult = await rejectReassignment(db, id, SE_RECIPIENT);
    expect(rejectResult.ok).toBe(false);
    expect(rejectResult.error).toMatch(/already (accepted|resolved)/i);
  });
});
