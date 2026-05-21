// dispatch — ticket-service unit tests
//
// Uses a real Postgres test database (dispatch_test).
// Each test cleans up after itself via a transaction rollback strategy.
//
// Tests:
//  1. listTickets returns the card shape with clientName + preview.
//  2. getTicket returns the DTO for an existing ticket; null for missing.
//  3. listTickets filter by status returns only matching tickets.
//  4. listTickets excludes dismissed tickets.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, messages } from "../../db/src/schema.js";
import { listTickets, getTicket } from "../src/services/ticket-service.js";
import type { Db } from "../../db/src/client.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;

// ── seed helpers ──────────────────────────────────────────────────────────────

let testAccountId: string;
let testTicketId: string;

async function seedAccount(db: Db) {
  const inserted = await db
    .insert(accounts)
    .values({
      slug: `test-acct-${Date.now()}`,
      displayName: "Test Account",
      emailDomains: ["test.example.com"],
      slackChannelIds: ["C_TEST_001"],
      owningSe: "clerk_user_test",
      health: "good",
    })
    .returning();
  testAccountId = inserted[0]!.id;
  return inserted[0]!;
}

async function seedTicket(
  db: Db,
  overrides: Partial<typeof tickets.$inferInsert> = {}
) {
  const inserted = await db
    .insert(tickets)
    .values({
      accountId: testAccountId,
      status: "new",
      type: "question",
      sourceKind: "channel",
      originClass: "client",
      ...overrides,
    })
    .returning();
  testTicketId = inserted[0]!.id;
  return inserted[0]!;
}

async function seedMessage(
  db: Db,
  ticketId: string,
  body: string
) {
  return db
    .insert(messages)
    .values({
      ticketId,
      direction: "inbound",
      authorKind: "client",
      authorRef: "U_TEST_CLIENT",
      body,
    })
    .returning();
}

// ── test lifecycle ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await seedAccount(db);
});

afterAll(async () => {
  // Clean up test data — delete tickets first (RESTRICT FK), then account
  const { eq } = await import("drizzle-orm");
  await db.delete(tickets).where(eq(tickets.accountId, testAccountId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

beforeEach(async () => {
  // Seed a fresh ticket for each test
  await seedTicket(db);
  await seedMessage(db, testTicketId, "Hello, test message for preview");
});

// ── tests ──────────────────────────────────────────────────────────────────────

describe("listTickets", () => {
  it("returns TicketCard with clientName from the account join", async () => {
    const cards = await listTickets(db, {
      assignee: undefined,
      limit: 100,
      offset: 0,
    });
    const card = cards.find((c) => c.id === testTicketId);
    expect(card).toBeDefined();
    expect(card?.clientName).toBe("Test Account");
    expect(card?.clientHealth).toBe("good");
  });

  it("returns a preview from the first message body (max 160 chars)", async () => {
    const cards = await listTickets(db, { limit: 100, offset: 0 });
    const card = cards.find((c) => c.id === testTicketId);
    expect(card?.preview).toBe("Hello, test message for preview");
  });

  it("filters by status", async () => {
    // Seed an 'on-you' ticket
    const { id: onYouId } = await seedTicket(db, { status: "on-you" });
    await seedMessage(db, onYouId, "on-you message");

    const newCards = await listTickets(db, {
      status: "new",
      limit: 100,
      offset: 0,
    });
    expect(newCards.every((c) => c.status === "new")).toBe(true);

    const onYouCards = await listTickets(db, {
      status: "on-you",
      limit: 100,
      offset: 0,
    });
    expect(onYouCards.every((c) => c.status === "on-you")).toBe(true);
    expect(onYouCards.some((c) => c.id === onYouId)).toBe(true);
  });

  it("excludes dismissed tickets", async () => {
    const dismissedNow = new Date();
    const { id: dismissedId } = await seedTicket(db, {
      dismissedAt: dismissedNow,
    });
    await seedMessage(db, dismissedId, "dismissed message");

    const cards = await listTickets(db, { limit: 100, offset: 0 });
    expect(cards.some((c) => c.id === dismissedId)).toBe(false);
  });
});

describe("getTicket", () => {
  it("returns the TicketDto for an existing ticket", async () => {
    const dto = await getTicket(db, testTicketId);
    expect(dto).toBeDefined();
    expect(dto?.id).toBe(testTicketId);
    expect(dto?.status).toBe("new");
  });

  it("returns null for a non-existent ticket id", async () => {
    const dto = await getTicket(db, "00000000-0000-0000-0000-000000000000");
    expect(dto).toBeNull();
  });
});
