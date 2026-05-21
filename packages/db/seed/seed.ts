// dispatch — seed script
//
// Seeds the database from boolean-knowledge/clients/_registry.yaml.
// Creates an Account per registry entry.
//
// Usage:
//   DATABASE_URL=postgresql://cody@localhost/dispatch_dev pnpm --filter @dispatch/db seed
//
// The registry is the source of truth. This seed is idempotent:
// it upserts by slug so re-running is safe.

import { createDb } from "../src/client.js";
import { accounts } from "../src/schema.js";
import { buildRegistry } from "../../core/src/registry/build-registry.js";
import { UNROUTED_ACCOUNT_SLUG } from "../../core/src/services/contact-discovery.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://cody@localhost:5432/dispatch_dev";

const REGISTRY_PATH =
  process.env.REGISTRY_PATH ??
  path.resolve(__dirname, "../../../../clients/_registry.yaml");

async function main() {
  const db = createDb(DATABASE_URL);

  console.log("Loading registry from:", REGISTRY_PATH);
  const entries = buildRegistry(REGISTRY_PATH);
  console.log(`Found ${entries.length} registry entries`);

  for (const entry of entries) {
    await db
      .insert(accounts)
      .values({
        slug: entry.slug,
        displayName: entry.displayName,
        emailDomains: entry.emailDomains,
        slackChannelIds: entry.slackChannelIds,
        owningSe: entry.owningSe ?? null,
        health: "good",
      })
      .onConflictDoUpdate({
        target: accounts.slug,
        set: {
          displayName: entry.displayName,
          emailDomains: entry.emailDomains,
          slackChannelIds: entry.slackChannelIds,
          owningSe: entry.owningSe ?? null,
        },
      });

    console.log(`  upserted: ${entry.slug}`);
  }

  // Ensure the reserved quarantine account always exists in seeded environments (P1-B)
  await db
    .insert(accounts)
    .values({
      slug: UNROUTED_ACCOUNT_SLUG,
      displayName: "Unrouted — unknown origin",
      emailDomains: [],
      slackChannelIds: [],
      owningSe: null,
      health: "good",
    })
    .onConflictDoNothing();

  console.log(`  upserted: ${UNROUTED_ACCOUNT_SLUG} (quarantine account)`);
  console.log("Seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
