-- dispatch — audit_launcher_fired migration
-- Phase 2 / Slice 4: server-side hash-only audit log of terminal launcher
-- button clicks. Codex F5 binding.
--
-- The web client computes SHA-256(command) via crypto.subtle BEFORE posting;
-- only the hash, the user id, the ticket display id, and the cosmetic label
-- land on the server. The raw command itself never leaves the SE's browser.
--
-- The dispatch operator (Cody/Chris) reads this table directly if a
-- compromise is suspected. SEs do not see it.

CREATE TABLE "audit_launcher_fired" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            TEXT NOT NULL,
  "ticket_display_id"  TEXT NOT NULL,
  "command_hash"       TEXT NOT NULL,
  "label"              TEXT NOT NULL,
  "fired_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user-recent reads: "show me what user X fired last week".
CREATE INDEX "audit_launcher_fired_user_fired_at_idx"
  ON "audit_launcher_fired" ("user_id", "fired_at" DESC);

-- Per-ticket-recent reads: "what launcher fires happened on DSP-2841?".
CREATE INDEX "audit_launcher_fired_ticket_fired_at_idx"
  ON "audit_launcher_fired" ("ticket_display_id", "fired_at" DESC);
