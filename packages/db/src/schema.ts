// dispatch — Drizzle schema: four domain entities + six support/infrastructure tables
//
// Domain entities:   accounts, contacts, tickets, messages
// Support tables:    internal_thread_messages, notifications, audit_log,
//                    reassignments, reinforcements, slack_outbox
//
// No local Engineer/User table — Clerk is the identity store.
// tickets.assignee and accounts.owning_se are Clerk user id strings.
//
// Migration numbering (plan §Slice 5 note):
//   0000_init.sql         — this file (Slice 3)
//   0001_slack_outbox.sql — slack_outbox (Slice 5)
//   0002_follow_up_1_sent.sql — follow_up_1_sent_at + enum extension (Slice 6)
//   0003_effort_bucket_check.sql — effort_bucket DB CHECK (Slice 7)
//   0004_reassignment_reinforcement.sql — reassignments + reinforcements (Slice 7)
//
// reassignments and reinforcements are defined here in the Drizzle schema so
// Slice 3 types compile cleanly, but their SQL migration ships in Slice 7.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  varchar,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Enums ──────────────────────────────────────────────────────────────────────

export const accountHealthEnum = pgEnum("account_health", [
  "good",
  "risk",
  "crit",
]);

export const ticketStatusEnum = pgEnum("ticket_status", [
  "new",
  "on-you",
  "waiting-client",
  "follow-up-required",
  "follow-up-1-sent", // added in schema; SQL added in 0002
  "closeout",
  "closed",
  "complete",
]);

export const ticketTypeEnum = pgEnum("ticket_type", [
  "question",
  "reply",
  "thanks",
  "ooo",
  "other",
]);

export const effortBucketEnum = pgEnum("effort_bucket", [
  "client-specific",
  "platform-shared",
  "one-time-build",
]);

export const sourceKindEnum = pgEnum("source_kind", [
  "channel",
  "dm",
  "group-dm",
  "email",
]);

export const originClassEnum = pgEnum("origin_class", [
  "client",
  "internal",
  "unknown",
]);

export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);

export const authorKindEnum = pgEnum("author_kind", ["client", "se"]);

export const reassignmentStatusEnum = pgEnum("reassignment_status", [
  "pending",
  "accepted",
  "rejected",
]);

export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "canceled",
  "sent",
  "failed",
]);

export const notificationKindEnum = pgEnum("notification_kind", [
  "reassignment-incoming",
  "reassignment-accepted",
  "reassignment-rejected",
  "follow-up-required",
  "closeout-required",
  "reinforcement-added",
  "ticket-assigned",
]);

export const auditEventEnum = pgEnum("audit_event", [
  "ticket.created",
  "ticket.status_changed",
  "ticket.assigned",
  "ticket.dismissed",
  "ticket.effort_bucket_set",
  "message.created",
  "account.highlights_updated",
  "reassignment.created",
  "reassignment.accepted",
  "reassignment.rejected",
  "reinforcement.added",
  "reinforcement.removed",
]);

// ── accounts ──────────────────────────────────────────────────────────────────
//
// One row per client. slug is the human-readable key (matches _registry.yaml).
// email_domains and slack_channel_ids are string arrays (Postgres TEXT[]).
// owning_se is a Clerk user id — the SE this Account routes to by default.

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  displayName: text("display_name").notNull(),
  emailDomains: text("email_domains").array().notNull().default(sql`'{}'::text[]`),
  slackChannelIds: text("slack_channel_ids").array().notNull().default(sql`'{}'::text[]`),
  owningSe: text("owning_se"), // Clerk user id; null = unowned
  health: accountHealthEnum("health").notNull().default("good"),
  highlights: text("highlights"), // human-curated rich text
  highlightsSourcePath: text("highlights_source_path"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── contacts ──────────────────────────────────────────────────────────────────
//
// A person at a client. Auto-discovered from channel membership or email domain.
// Not hand-maintained — see contact-discovery service.

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name"),
    email: text("email"),
    slackUserId: text("slack_user_id"),
    role: text("role"), // free-form role label from their Slack profile
    discoveredVia: text("discovered_via").notNull().default("channel-membership"),
    // 'channel-membership' | 'email-domain'
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Partial unique indexes matching 0000_init.sql:
    //   WHERE email IS NOT NULL / WHERE slack_user_id IS NOT NULL
    // Drizzle schema parity so a future drizzle-kit run cannot drop the partial
    // predicates and replace them with non-partial indexes (P2-2).
    emailUniq: uniqueIndex("contacts_email_uniq")
      .on(t.email)
      .where(sql`${t.email} IS NOT NULL`),
    slackUserUniq: uniqueIndex("contacts_slack_user_uniq")
      .on(t.slackUserId)
      .where(sql`${t.slackUserId} IS NOT NULL`),
  })
);

// ── tickets ───────────────────────────────────────────────────────────────────
//
// One unit of client work. Born from a top-level client message OR hand-created.
// display_id uses a Postgres sequence starting at 2900 (DSP-2900+).
// source_event_ts: the originating Slack event ts — persisted dedup key so
//   idempotency on (source_channel_id, source_event_ts) survives restarts.
// origin_class: 'client' | 'unknown'. 'internal' is never stamped (no Ticket).
// follow_up_1_sent_at: stamped when the SE sends the first follow-up from
//   Follow-up Required → Follow-up 1 Sent (Slice 6, FIX 4).

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    displayId: text("display_id")
      .notNull()
      .unique()
      .default(sql`'DSP-' || nextval('ticket_display_seq')::text`),
    // Generated as 'DSP-' || nextval('ticket_display_seq') in 0000_init.sql
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    status: ticketStatusEnum("status").notNull().default("new"),
    type: ticketTypeEnum("type").notNull().default("question"),
    assignee: text("assignee"), // Clerk user id; null = unassigned
    effortBucket: effortBucketEnum("effort_bucket"), // nullable while open
    sourceKind: sourceKindEnum("source_kind").notNull().default("channel"),
    sourceChannelId: text("source_channel_id"),
    sourceEventTs: text("source_event_ts"),
    // Dedup key: (source_channel_id, source_event_ts) must be unique
    originClass: originClassEnum("origin_class").notNull().default("client"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    followUp1SentAt: timestamp("follow_up_1_sent_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    slaDeadline: timestamp("sla_deadline", { withTimezone: true }),
    slaPaused: boolean("sla_paused").notNull().default(false),
    // Stamped ONLY when the ticket transitions INTO 'waiting-client'.
    // Cleared when the ticket transitions OUT of 'waiting-client'.
    // The SLA timer reads this instead of updatedAt to measure the silence window
    // so that unrelated ticket mutations (effort-bucket sets, audit appends) do
    // not reset the follow-up clock. Added in migration 0005. (P2-3)
    waitingClientSinceAt: timestamp("waiting_client_since_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Partial unique index matching 0000_init.sql:
    // WHERE source_channel_id IS NOT NULL AND source_event_ts IS NOT NULL
    // Drizzle uniqueIndex().where() encodes the partial predicate so a future
    // drizzle-kit run cannot drift from the SQL definition (P2-J).
    sourceDedup: uniqueIndex("tickets_source_dedup")
      .on(t.sourceChannelId, t.sourceEventTs)
      .where(
        sql`${t.sourceChannelId} IS NOT NULL AND ${t.sourceEventTs} IS NOT NULL`
      ),
  })
);

// ── messages ─────────────────────────────────────────────────────────────────
//
// A single inbound or outbound client-facing communication on a Ticket.
// Thread replies attach to the parent Ticket via ticket_id — they do NOT
// spawn new Tickets (ADR-005 grain).
// slack_ts: dedup key for thread-reply Messages (idempotency on re-delivery).

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    direction: messageDirectionEnum("direction").notNull(),
    authorKind: authorKindEnum("author_kind").notNull(),
    authorRef: text("author_ref").notNull(),
    // For client messages: Slack user id. For SE messages: Clerk user id.
    body: text("body").notNull(),
    slackTs: text("slack_ts"), // Dedup key for thread-reply re-delivery
    postedAt: timestamp("posted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Partial unique index matching 0000_init.sql:
    // WHERE slack_ts IS NOT NULL
    // Drizzle schema parity so a future drizzle-kit run cannot drift (P2-J).
    slackTsUniq: uniqueIndex("messages_slack_ts_uniq")
      .on(t.slackTs)
      .where(sql`${t.slackTs} IS NOT NULL`),
  })
);

// ── internal_thread_messages ──────────────────────────────────────────────────
//
// Per-Ticket internal discussion data. Dispatch-native only; never written to
// Slack (spec §3.8, A21). NOT a fifth domain entity — child table of tickets.

export const internalThreadMessages = pgTable("internal_thread_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull(), // Clerk user id
  body: text("body").notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── notifications ──────────────────────────────────────────────────────────────
//
// Per-SE notification center. Built incrementally: table here in Slice 3,
// populated in Slices 4+.

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  recipientId: text("recipient_id").notNull(), // Clerk user id
  kind: notificationKindEnum("kind").notNull(),
  ticketId: uuid("ticket_id").references(() => tickets.id, {
    onDelete: "cascade",
  }),
  payload: jsonb("payload"), // kind-specific data
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── audit_log ──────────────────────────────────────────────────────────────────
//
// Immutable append-only log. Every mutation writes a row.
// The Ticket-detail Activity panel reads this via GET /api/tickets/:id/activity.

export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id").references(() => tickets.id, {
    onDelete: "cascade",
  }),
  actorId: text("actor_id"), // Clerk user id; null for system events
  event: auditEventEnum("event").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  meta: jsonb("meta"), // extra context (e.g. undo_token ref)
  undoToken: text("undo_token"), // links this log entry to its undo token
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── reassignments ──────────────────────────────────────────────────────────────
//
// Holds the pending-handoff state for the reassignment handshake (A26).
// While pending, tickets.assignee does NOT change (stays with original SE).
// On accept → assignee moves to recipient. On reject → stays with original SE.
// Schema defined here; SQL migration ships in Slice 7 (0004).

export const reassignments = pgTable("reassignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  proposer: text("proposer").notNull(), // Clerk user id
  recipient: text("recipient").notNull(), // Clerk user id
  status: reassignmentStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// ── reinforcements ─────────────────────────────────────────────────────────────
//
// Many-to-many: Ticket × collaborator (Clerk user id).
// Reinforcement adds a collaborator under the "Shared Issues" view.
// tickets.assignee is unchanged. Schema defined here; SQL migration in Slice 7.

export const reinforcements = pgTable(
  "reinforcements",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    collaborator: text("collaborator").notNull(), // Clerk user id
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex("reinforcements_pk").on(t.ticketId, t.collaborator),
  })
);

// ── slack_outbox ──────────────────────────────────────────────────────────────
//
// Durable pre-send buffer for the OQ-4 / §5 undo window (FIX 6).
// Schema defined here; SQL migration ships in Slice 5 (0001).
// The reply endpoint inserts a 'pending' row; the undo path marks it 'canceled';
// the outbox worker polls 'pending' rows past scheduled_at and fires the send.

export const slackOutbox = pgTable("slack_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  channelId: text("channel_id").notNull(),
  payload: jsonb("payload").notNull(), // resolved chat.postMessage arguments
  status: outboxStatusEnum("status").notNull().default("pending"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// ── type exports ──────────────────────────────────────────────────────────────

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type InternalThreadMessage = typeof internalThreadMessages.$inferSelect;
export type NewInternalThreadMessage =
  typeof internalThreadMessages.$inferInsert;

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;

export type Reassignment = typeof reassignments.$inferSelect;
export type NewReassignment = typeof reassignments.$inferInsert;

export type Reinforcement = typeof reinforcements.$inferSelect;
export type NewReinforcement = typeof reinforcements.$inferInsert;

export type SlackOutbox = typeof slackOutbox.$inferSelect;
export type NewSlackOutbox = typeof slackOutbox.$inferInsert;
