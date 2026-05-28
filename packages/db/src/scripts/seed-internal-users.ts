// dispatch — seed-internal-users
//
// Reads Boolean staff Clerk IDs from environment variables and upserts rows
// into the internal_users table. Safe to run repeatedly (idempotent via
// ON CONFLICT DO UPDATE).
//
// Required env vars (set in Railway + local .env):
//   CODY_CLERK_ID     — Cody's Clerk user id
//   CHRIS_CLERK_ID    — Chris's Clerk user id
//   JUSTIN_CLERK_ID   — Justin's Clerk user id
//   DAN_CLERK_ID      — Dan's Clerk user id
//   EVEGUEL_CLERK_ID  — Eveguel's Clerk user id
//
// Corresponding Slack IDs (optional — improves authorRef matching):
//   CODY_SLACK_ID, CHRIS_SLACK_ID, JUSTIN_SLACK_ID, DAN_SLACK_ID,
//   EVEGUEL_SLACK_ID
//
// Usage:
//   DATABASE_URL=postgres://... tsx packages/db/src/scripts/seed-internal-users.ts
//   DATABASE_URL=postgres://... tsx packages/db/src/scripts/seed-internal-users.ts --dry-run

import { sql } from "drizzle-orm";
import { createDb } from "../client.js";
import { internalUsers } from "../schema.js";

interface InternalUserSeed {
  clerkId: string;
  slackId?: string;
  label: string;
}

function buildSeedList(): InternalUserSeed[] {
  const entries: InternalUserSeed[] = [];

  const roster = [
    { envKey: "CODY_CLERK_ID",    slackEnv: "CODY_SLACK_ID",    label: "Cody" },
    { envKey: "CHRIS_CLERK_ID",   slackEnv: "CHRIS_SLACK_ID",   label: "Chris" },
    { envKey: "JUSTIN_CLERK_ID",  slackEnv: "JUSTIN_SLACK_ID",  label: "Justin" },
    { envKey: "DAN_CLERK_ID",     slackEnv: "DAN_SLACK_ID",     label: "Dan" },
    { envKey: "EVEGUEL_CLERK_ID", slackEnv: "EVEGUEL_SLACK_ID", label: "Eveguel" },
  ] as const;

  for (const { envKey, slackEnv, label } of roster) {
    const clerkId = process.env[envKey];
    if (!clerkId) {
      console.warn(`[seed-internal-users] ${envKey} not set — skipping ${label}`);
      continue;
    }
    const slackId = process.env[slackEnv] ?? undefined;
    entries.push({ clerkId, slackId, label });
  }

  return entries;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("[seed-internal-users] DATABASE_URL is required");
    process.exit(1);
  }

  const seedList = buildSeedList();

  if (seedList.length === 0) {
    console.log("[seed-internal-users] No entries to seed (all env vars missing). Done.");
    return;
  }

  console.log(`[seed-internal-users] ${dryRun ? "DRY RUN — " : ""}Seeding ${seedList.length} internal user(s):`);
  for (const e of seedList) {
    console.log(`  ${e.label}: clerkId=${e.clerkId}${e.slackId ? ` slackId=${e.slackId}` : ""}`);
  }

  if (dryRun) {
    console.log("[seed-internal-users] Dry run complete — no writes.");
    return;
  }

  const db = createDb(databaseUrl);

  for (const entry of seedList) {
    await db
      .insert(internalUsers)
      .values({
        clerkId: entry.clerkId,
        slackId: entry.slackId ?? null,
        label: entry.label,
      })
      .onConflictDoUpdate({
        target: internalUsers.clerkId,
        set: {
          slackId: entry.slackId ?? sql`EXCLUDED.slack_id`,
          label: entry.label,
          updatedAt: sql`NOW()`,
        },
      });
    console.log(`[seed-internal-users] Upserted: ${entry.label} (${entry.clerkId})`);
  }

  console.log("[seed-internal-users] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-internal-users] Fatal:", err);
  process.exit(1);
});
