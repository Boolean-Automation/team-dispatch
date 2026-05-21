-- dispatch — initial schema migration
-- Slice 3: four domain entities + infrastructure/support tables
-- (reassignments, reinforcements, slack_outbox schemas defined here but
--  their migrations ship in Slices 5 and 7 respectively)

-- ── Enums ──────────────────────────────────────────────────────────────────

CREATE TYPE "account_health" AS ENUM ('good', 'risk', 'crit');

CREATE TYPE "ticket_status" AS ENUM (
  'new',
  'on-you',
  'waiting-client',
  'follow-up-required',
  'follow-up-1-sent',
  'closeout',
  'closed',
  'complete'
);

CREATE TYPE "ticket_type" AS ENUM (
  'question',
  'reply',
  'thanks',
  'ooo',
  'other'
);

CREATE TYPE "effort_bucket" AS ENUM (
  'client-specific',
  'platform-shared',
  'one-time-build'
);

CREATE TYPE "source_kind" AS ENUM (
  'channel',
  'dm',
  'group-dm',
  'email'
);

CREATE TYPE "origin_class" AS ENUM (
  'client',
  'internal',
  'unknown'
);

CREATE TYPE "message_direction" AS ENUM (
  'inbound',
  'outbound'
);

CREATE TYPE "author_kind" AS ENUM (
  'client',
  'se'
);

CREATE TYPE "reassignment_status" AS ENUM (
  'pending',
  'accepted',
  'rejected'
);

CREATE TYPE "outbox_status" AS ENUM (
  'pending',
  'canceled',
  'sent',
  'failed'
);

CREATE TYPE "notification_kind" AS ENUM (
  'reassignment-incoming',
  'reassignment-accepted',
  'reassignment-rejected',
  'follow-up-required',
  'closeout-required',
  'reinforcement-added',
  'ticket-assigned'
);

CREATE TYPE "audit_event" AS ENUM (
  'ticket.created',
  'ticket.status_changed',
  'ticket.assigned',
  'ticket.dismissed',
  'ticket.effort_bucket_set',
  'message.created',
  'account.highlights_updated',
  'reassignment.created',
  'reassignment.accepted',
  'reassignment.rejected',
  'reinforcement.added',
  'reinforcement.removed'
);

-- ── Display ID sequence (OQ-6: starts at 2900) ───────────────────────────────

CREATE SEQUENCE ticket_display_seq
  START WITH 2900
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

-- ── accounts ──────────────────────────────────────────────────────────────────

CREATE TABLE "accounts" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"                  VARCHAR(64) NOT NULL UNIQUE,
  "display_name"          TEXT NOT NULL,
  "email_domains"         TEXT[] NOT NULL DEFAULT '{}',
  "slack_channel_ids"     TEXT[] NOT NULL DEFAULT '{}',
  "owning_se"             TEXT,
  "health"                "account_health" NOT NULL DEFAULT 'good',
  "highlights"            TEXT,
  "highlights_source_path" TEXT,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── contacts ──────────────────────────────────────────────────────────────────

CREATE TABLE "contacts" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"      UUID NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "name"            TEXT,
  "email"           TEXT,
  "slack_user_id"   TEXT,
  "role"            TEXT,
  "discovered_via"  TEXT NOT NULL DEFAULT 'channel-membership',
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- email and slack_user_id each unique (if non-null)
CREATE UNIQUE INDEX "contacts_email_uniq"
  ON "contacts" ("email") WHERE "email" IS NOT NULL;
CREATE UNIQUE INDEX "contacts_slack_user_uniq"
  ON "contacts" ("slack_user_id") WHERE "slack_user_id" IS NOT NULL;

-- ── tickets ───────────────────────────────────────────────────────────────────

CREATE TABLE "tickets" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "display_id"          TEXT NOT NULL UNIQUE
                          DEFAULT ('DSP-' || nextval('ticket_display_seq')::TEXT),
  "account_id"          UUID NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "status"              "ticket_status" NOT NULL DEFAULT 'new',
  "type"                "ticket_type" NOT NULL DEFAULT 'question',
  "assignee"            TEXT,
  "effort_bucket"       "effort_bucket",
  "source_kind"         "source_kind" NOT NULL DEFAULT 'channel',
  "source_channel_id"   TEXT,
  "source_event_ts"     TEXT,
  "origin_class"        "origin_class" NOT NULL DEFAULT 'client',
  "opened_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "first_response_at"   TIMESTAMPTZ,
  "follow_up_1_sent_at" TIMESTAMPTZ,
  "resolved_at"         TIMESTAMPTZ,
  "sla_deadline"        TIMESTAMPTZ,
  "sla_paused"          BOOLEAN NOT NULL DEFAULT FALSE,
  "dismissed_at"        TIMESTAMPTZ,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Persisted dedup key: (source_channel_id, source_event_ts)
-- NULL values are excluded so hand-created tickets with no source_event_ts
-- don't block each other.
CREATE UNIQUE INDEX "tickets_source_dedup"
  ON "tickets" ("source_channel_id", "source_event_ts")
  WHERE "source_channel_id" IS NOT NULL AND "source_event_ts" IS NOT NULL;

-- ── messages ─────────────────────────────────────────────────────────────────

CREATE TABLE "messages" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticket_id"   UUID NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "direction"   "message_direction" NOT NULL,
  "author_kind" "author_kind" NOT NULL,
  "author_ref"  TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "slack_ts"    TEXT,
  "posted_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "messages_slack_ts_uniq"
  ON "messages" ("slack_ts")
  WHERE "slack_ts" IS NOT NULL;

-- ── internal_thread_messages ──────────────────────────────────────────────────

CREATE TABLE "internal_thread_messages" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticket_id"   UUID NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "author_id"   TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "posted_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── notifications ──────────────────────────────────────────────────────────────

CREATE TABLE "notifications" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "recipient_id"  TEXT NOT NULL,
  "kind"          "notification_kind" NOT NULL,
  "ticket_id"     UUID REFERENCES "tickets"("id") ON DELETE CASCADE,
  "payload"       JSONB,
  "read_at"       TIMESTAMPTZ,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "notifications_recipient_idx" ON "notifications" ("recipient_id");
CREATE INDEX "notifications_unread_idx"
  ON "notifications" ("recipient_id")
  WHERE "read_at" IS NULL;

-- ── audit_log ──────────────────────────────────────────────────────────────────

CREATE TABLE "audit_log" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticket_id"   UUID REFERENCES "tickets"("id") ON DELETE CASCADE,
  "actor_id"    TEXT,
  "event"       "audit_event" NOT NULL,
  "before"      JSONB,
  "after"       JSONB,
  "meta"        JSONB,
  "undo_token"  TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "audit_log_ticket_idx" ON "audit_log" ("ticket_id");
