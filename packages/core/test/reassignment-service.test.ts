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
