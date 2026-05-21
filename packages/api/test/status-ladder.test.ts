// dispatch — status-ladder integration tests (api layer)
//
// Tests:
//   1. PATCH /api/tickets/:id/status — valid transition returns 200.
//   2. PATCH /api/tickets/:id/status — disallowed transition returns 422.
//   3. PATCH /api/tickets/:id/status — invalid status value returns 400.
//   4. PATCH /api/tickets/:id/status — non-existent ticket returns 404.
//   5. PATCH /api/tickets/:id/status — requires Clerk auth (401 without token).
//   6. Full 7-state chain: New → On You → Waiting on Client → Follow-up Required
//      → Follow-up 1 Sent → Closeout → Closed via a real DB walk.
//   7. SE first-follow-up: on a follow-up-required ticket, sendReply with
//      resolveTicket=true → follow-up-1-sent AND stamps followUp1SentAt.
//   8. SLA timer advance (waiting-client → follow-up-required, directly via
//      runSlaAdvances with a backdated updatedAt) — no Slack send.
//   9. SLA timer advance (follow-up-1-sent → closeout, counted from followUp1SentAt)
//      — no Slack send.
//  10. complete is reachable via manual PATCH from any status.
//  11. A reply on on-you with resolveTicket=true → waiting-client (A15, not closed).
//  12. Client reply on waiting-client ticket flips it to on-you (A16 — via ingest).
//  13. Client reply on closed ticket reopens to on-you (A17 — via ingest).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import {
  _setClerkVerifierForTest,
  _resetClerkVerifier,
} from "../src/plugins/clerk-auth.js";
import { createDb } from "../../db/src/client.js";
import {
  accounts,
  tickets,
  messages,
  slackOutbox,
  auditLog,
  notifications,
} from "../../db/src/schema.js";
import { eq, and } from "drizzle-orm";
import { sendReply } from "../../core/src/services/reply-service.js";
import { runSlaAdvances } from "../src/jobs/sla-timer.js";
import { ingestMessage } from "../../core/src/ingestion/ingest-message.js";
import type { ParsedRegistry } from "../../core/src/registry/build-registry.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

const db = createDb(DATABASE_URL);

let app: FastifyInstance;
let testAccountId: string;
let testTicketId: string;

// ── Seed ──────────────────────────────────────────────────────────────────────

async function seedData() {
  const acct = await db
    .insert(accounts)
    .values({
      slug: `sl-api-test-${Date.now()}`,
      displayName: "Status Ladder API Test Account",
      health: "good",
      slackChannelIds: ["C_SL_TEST"],
    })
    .returning();
  testAccountId = acct[0]!.id;

  const tkt = await db
    .insert(tickets)
    .values({
      accountId: testAccountId,
      status: "new",
      type: "question",
      sourceKind: "channel",
      sourceChannelId: "C_SL_TEST",
      sourceEventTs: `sl-test-${Date.now()}`,
      originClass: "client",
    })
    .returning();
  testTicketId = tkt[0]!.id;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _setClerkVerifierForTest(async (token: string) => {
    if (token === "valid-se-token") {
      return { sub: "user_sl_se", public_metadata: { role: "se" } };
    }
    throw new Error("invalid token");
  });

  await seedData();
  app = await buildServer({ db });
  await app.ready();
});

afterAll(async () => {
  _resetClerkVerifier();
  await app.close();

  // Clean up — delete in dependency order
  await db.delete(notifications).where(eq(notifications.ticketId, testTicketId));
  await db.delete(slackOutbox).where(eq(slackOutbox.ticketId, testTicketId));
  await db.delete(auditLog).where(eq(auditLog.ticketId, testTicketId));
  await db.delete(messages).where(eq(messages.ticketId, testTicketId));
  await db.delete(tickets).where(eq(tickets.id, testTicketId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function getTicketStatus() {
  const rows = await db
    .select({ status: tickets.status })
    .from(tickets)
    .where(eq(tickets.id, testTicketId))
    .limit(1);
  return rows[0]?.status ?? null;
}

async function setTicketStatus(status: string) {
  await db
    .update(tickets)
    .set({ status: status as typeof tickets.$inferSelect.status, updatedAt: new Date() })
    .where(eq(tickets.id, testTicketId));
}

// ── Route tests ───────────────────────────────────────────────────────────────

describe("PATCH /api/tickets/:id/status", () => {
  it("returns 401 without auth token", async () => {
    const res = await supertest(app.server)
      .patch(`/api/tickets/${testTicketId}/status`)
      .send({ status: "on-you" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid status value", async () => {
    const res = await supertest(app.server)
      .patch(`/api/tickets/${testTicketId}/status`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ status: "not-a-real-status" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent ticket", async () => {
    const res = await supertest(app.server)
      .patch(`/api/tickets/00000000-0000-0000-0000-000000000000/status`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ status: "on-you" });
    expect(res.status).toBe(404);
  });

  it("returns 422 for a disallowed transition (new → closed)", async () => {
    await setTicketStatus("new");
    const res = await supertest(app.server)
      .patch(`/api/tickets/${testTicketId}/status`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ status: "closed" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/not allowed/i);
  });

  it("returns 200 for a valid transition (new → on-you)", async () => {
    await setTicketStatus("new");
    const res = await supertest(app.server)
      .patch(`/api/tickets/${testTicketId}/status`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ status: "on-you" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newStatus).toBe("on-you");
    expect(res.body.undoToken).toBeTruthy();
  });
});

// ── Full 7-state chain ────────────────────────────────────────────────────────

describe("Full 7-state ladder chain via PATCH", () => {
  it("walks New → On You → Waiting on Client → Follow-up Required → Follow-up 1 Sent → Closeout → Closed", async () => {
    // Reset to new
    await setTicketStatus("new");
    // Set effort bucket so we can reach closed
    await db
      .update(tickets)
      .set({ effortBucket: "client-specific", updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));

    const ladder = [
      { from: "new", to: "on-you" },
      { from: "on-you", to: "waiting-client" },
      { from: "waiting-client", to: "follow-up-required" },
      { from: "follow-up-required", to: "follow-up-1-sent" },
      { from: "follow-up-1-sent", to: "closeout" },
      { from: "closeout", to: "closed" },
    ];

    for (const step of ladder) {
      // Verify current status
      const currentStatus = await getTicketStatus();
      expect(currentStatus, `Expected ${step.from} before PATCH`).toBe(step.from);

      const res = await supertest(app.server)
        .patch(`/api/tickets/${testTicketId}/status`)
        .set("Authorization", "Bearer valid-se-token")
        .send({ status: step.to });

      expect(res.status, `PATCH ${step.from}→${step.to} should return 200`).toBe(200);
      expect(res.body.newStatus).toBe(step.to);

      const afterStatus = await getTicketStatus();
      expect(afterStatus, `After PATCH, status should be ${step.to}`).toBe(step.to);
    }
  });
});

// ── Complete (A19) ────────────────────────────────────────────────────────────

describe("complete is reachable via manual PATCH (A19)", () => {
  it("on-you → complete succeeds", async () => {
    await setTicketStatus("on-you");
    await db
      .update(tickets)
      .set({ effortBucket: "client-specific", updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));

    const res = await supertest(app.server)
      .patch(`/api/tickets/${testTicketId}/status`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ status: "complete" });

    expect(res.status).toBe(200);
    expect(res.body.newStatus).toBe("complete");

    // Reset for further tests
    await setTicketStatus("on-you");
    await db.update(tickets).set({ resolvedAt: null }).where(eq(tickets.id, testTicketId));
  });
});

// ── SE first follow-up (FIX 4) ────────────────────────────────────────────────

describe("SE first follow-up: follow-up-required → follow-up-1-sent (FIX 4)", () => {
  it("sendReply with resolveTicket=true from follow-up-required stamps followUp1SentAt", async () => {
    // Set ticket to follow-up-required
    await setTicketStatus("follow-up-required");
    await db
      .update(tickets)
      .set({ followUp1SentAt: null, updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));

    const before = await db
      .select({ followUp1SentAt: tickets.followUp1SentAt })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(before[0]?.followUp1SentAt).toBeNull();

    const result = await sendReply({
      db,
      ticketId: testTicketId,
      actorId: "user_sl_se",
      body: "Following up on your request — wanted to check in.",
      actorName: "Dan Chen",
      resolveTicket: true,
    });

    expect(result.message.direction).toBe("outbound");

    const after = await db
      .select({ status: tickets.status, followUp1SentAt: tickets.followUp1SentAt })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);

    expect(after[0]?.status).toBe("follow-up-1-sent");
    expect(after[0]?.followUp1SentAt).not.toBeNull();
  });
});

// ── Reply → waiting-client (A15) ──────────────────────────────────────────────

describe("A15: sendReply with resolveTicket=true from on-you → waiting-client (not closed)", () => {
  it("does NOT move ticket to closed — moves to waiting-client", async () => {
    await setTicketStatus("on-you");

    const result = await sendReply({
      db,
      ticketId: testTicketId,
      actorId: "user_sl_se",
      body: "Looking into this for you.",
      actorName: "Dan Chen",
      resolveTicket: true,
    });

    expect(result.message.direction).toBe("outbound");

    const row = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);

    expect(row[0]?.status).toBe("waiting-client");
    expect(row[0]?.status).not.toBe("closed");
  });
});

// ── SLA timer: waiting-client → follow-up-required ───────────────────────────

describe("SLA timer advance 1: waiting-client → follow-up-required (A18)", () => {
  it("runSlaAdvances advances a waiting-client ticket past 2 business days", async () => {
    await setTicketStatus("waiting-client");

    // P2-3: stamp waiting_client_since_at to simulate the ticket entering
    // waiting-client 2+ business days ago. The timer now reads this field
    // instead of updatedAt (effort-bucket changes no longer reset the clock).
    const backdatedAt = new Date("2024-01-01T14:00:00Z");
    await db
      .update(tickets)
      .set({ updatedAt: backdatedAt, waitingClientSinceAt: backdatedAt })
      .where(eq(tickets.id, testTicketId));

    // Run the SLA timer during "business hours" — we pass a known business-hours
    // timestamp as `now` to bypass the isBusinessHours check.
    // Mon Jan 8 2024 10am PT = 18:00 UTC
    const bizNow = new Date("2024-01-08T18:00:00Z");
    await runSlaAdvances(db, bizNow);

    const row = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);

    expect(row[0]?.status).toBe("follow-up-required");
  });
});

// ── SLA timer: follow-up-1-sent → closeout ───────────────────────────────────

describe("SLA timer advance 2: follow-up-1-sent → closeout (A18, 3bd from followUp1SentAt)", () => {
  it("runSlaAdvances advances a follow-up-1-sent ticket past 3 business days from followUp1SentAt", async () => {
    await setTicketStatus("follow-up-1-sent");

    // Backdate followUp1SentAt to simulate 3+ business days ago.
    const backdatedFollowUp = new Date("2024-01-01T14:00:00Z");
    await db
      .update(tickets)
      .set({ followUp1SentAt: backdatedFollowUp, updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));

    // Mon Jan 8 2024 10am PT
    const bizNow = new Date("2024-01-08T18:00:00Z");
    await runSlaAdvances(db, bizNow);

    const row = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);

    expect(row[0]?.status).toBe("closeout");
  });
});

// ── Timer does not advance follow-up-required ────────────────────────────────

describe("SLA timer does NOT advance follow-up-required (waits for SE first follow-up)", () => {
  it("runSlaAdvances leaves follow-up-required unchanged", async () => {
    await setTicketStatus("follow-up-required");

    // The timer should ignore follow-up-required tickets
    const bizNow = new Date("2024-01-08T18:00:00Z");
    await runSlaAdvances(db, bizNow);

    const row = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);

    // Status must remain follow-up-required
    expect(row[0]?.status).toBe("follow-up-required");
  });
});

// ── A16: client reply while waiting-client → on-you ──────────────────────────

describe("A16: client reply on waiting-client ticket flips to on-you", () => {
  it("ingestMessage of a thread reply flips waiting-client → on-you", async () => {
    // Set ticket to waiting-client with a known source_event_ts for thread lookup
    const eventTs = `thread-a16-${Date.now()}`;
    await setTicketStatus("waiting-client");
    await db
      .update(tickets)
      .set({ sourceEventTs: eventTs, updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));

    const registry: ParsedRegistry = { clients: [], internalChannelIds: [] };

    // Simulate a client thread reply
    const result = await ingestMessage({
      db,
      event: {
        channelId: "C_SL_TEST",
        eventTs: `${eventTs}-reply-1`,
        threadTs: eventTs,
        isTopLevel: false,
        authorRef: "U_CLIENT",
        body: "Got your reply, thanks!",
        source: "stub",
      },
      registry,
    });

    expect(result.kind).toBe("message-created");

    const row = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);

    expect(row[0]?.status).toBe("on-you");
  });
});

// ── A17: client reply on closed ticket → on-you (reopen) ─────────────────────

describe("A17: client reply on closed ticket reopens to on-you", () => {
  it("ingestMessage of a thread reply reopens a closed ticket", async () => {
    // Set ticket to closed
    const eventTs2 = `thread-a17-${Date.now()}`;
    await setTicketStatus("closed");
    await db
      .update(tickets)
      .set({ sourceEventTs: eventTs2, updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));

    const registry: ParsedRegistry = { clients: [], internalChannelIds: [] };

    const result = await ingestMessage({
      db,
      event: {
        channelId: "C_SL_TEST",
        eventTs: `${eventTs2}-reopen-1`,
        threadTs: eventTs2,
        isTopLevel: false,
        authorRef: "U_CLIENT",
        body: "Actually I have another question.",
        source: "stub",
      },
      registry,
    });

    expect(result.kind).toBe("message-created");

    const row = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);

    expect(row[0]?.status).toBe("on-you");
  });
});
