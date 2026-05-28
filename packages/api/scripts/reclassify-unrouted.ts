// dispatch — reclassify-unrouted
//
// Re-runs classifyOrigin() against every Ticket where:
//   origin_class = 'unknown'
//   account_id   = <__unrouted__ account id>
//
// This is the remediation script for the Stage 1 substrate-split fix.
// After REGISTRY_PATH is set and the railway deploy confirms
// "[dispatch] registry loaded" with registryClientCount > 0, run this
// script with --commit to re-route previously-unrouted tickets to their
// correct client accounts.
//
// Usage:
//   DATABASE_URL=... REGISTRY_PATH=/path/to/registry.yaml \
//     tsx packages/api/scripts/reclassify-unrouted.ts          # dry-run (default)
//   DATABASE_URL=... REGISTRY_PATH=/path/to/registry.yaml \
//     tsx packages/api/scripts/reclassify-unrouted.ts --commit  # write
//
// Output:
//   Each ticket is printed with:
//     DSP-NNNN | channelId | currentAccountId → newAccountId (slug)
//   Dry-run: prints diff, no writes.
//   Commit: updates tickets.account_id + tickets.origin_class.

import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "@dispatch/db";
import { tickets, accounts } from "@dispatch/db";
import { parseRegistry, classifyOrigin } from "@dispatch/core";

const UNROUTED_SLUG = "__unrouted__";

async function main() {
  const dryRun = !process.argv.includes("--commit");
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("[reclassify-unrouted] DATABASE_URL is required");
    process.exit(1);
  }

  const registryPath =
    process.env.REGISTRY_PATH ??
    path.resolve(process.cwd(), "../../boolean-knowledge/clients/_registry.yaml");

  if (!fs.existsSync(registryPath)) {
    console.error(`[reclassify-unrouted] Registry not found at ${registryPath}`);
    console.error("  Set REGISTRY_PATH or ensure boolean-knowledge is accessible.");
    process.exit(1);
  }

  const db = createDb(databaseUrl);
  const registry = parseRegistry(registryPath);

  console.log(
    `[reclassify-unrouted] ${dryRun ? "DRY RUN — " : ""}Registry loaded: ` +
      `${registry.clients.length} client(s), ` +
      `${registry.internalChannelIds.length} internal channel(s)`
  );

  // Find the __unrouted__ account id
  const unroutedRows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.slug, UNROUTED_SLUG))
    .limit(1);

  if (unroutedRows.length === 0) {
    console.log("[reclassify-unrouted] No __unrouted__ account found. Nothing to do.");
    process.exit(0);
  }

  const unroutedAccountId = unroutedRows[0]!.id;
  console.log(`[reclassify-unrouted] __unrouted__ account id: ${unroutedAccountId}`);

  // Find all tickets on __unrouted__ with origin_class='unknown'
  const unroutedTickets = await db
    .select({
      id: tickets.id,
      displayId: tickets.displayId,
      sourceChannelId: tickets.sourceChannelId,
      accountId: tickets.accountId,
      originClass: tickets.originClass,
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.accountId, unroutedAccountId),
        eq(tickets.originClass, "unknown")
      )
    );

  console.log(`[reclassify-unrouted] Found ${unroutedTickets.length} unrouted ticket(s)`);

  if (unroutedTickets.length === 0) {
    console.log("[reclassify-unrouted] Nothing to reclassify.");
    process.exit(0);
  }

  // Build a channel → account lookup from registry
  const channelToEntry: Map<string, { slug: string }> = new Map();
  for (const client of registry.clients) {
    for (const channelId of client.slackChannelIds) {
      channelToEntry.set(channelId, { slug: client.slug });
    }
  }

  // Load accounts by slug for id resolution
  const allAccounts = await db
    .select({ id: accounts.id, slug: accounts.slug })
    .from(accounts);

  const slugToAccountId: Map<string, string> = new Map();
  for (const acct of allAccounts) {
    slugToAccountId.set(acct.slug, acct.id);
  }

  let reclassified = 0;
  let stillUnknown = 0;

  for (const ticket of unroutedTickets) {
    const channelId = ticket.sourceChannelId;
    if (!channelId) {
      console.log(`  ${ticket.displayId} | (no channelId) → still unknown`);
      stillUnknown++;
      continue;
    }

    const { originClass, entry } = classifyOrigin(channelId, registry);

    if (originClass !== "client" || !entry) {
      console.log(`  ${ticket.displayId} | ${channelId} → still unknown (not in registry)`);
      stillUnknown++;
      continue;
    }

    const newAccountId = slugToAccountId.get(entry.slug);
    if (!newAccountId) {
      console.log(
        `  ${ticket.displayId} | ${channelId} → slug '${entry.slug}' not in accounts table ` +
          "(registry entry without a DB row)"
      );
      stillUnknown++;
      continue;
    }

    console.log(
      `  ${ticket.displayId} | ${channelId} | ` +
        `${ticket.accountId} → ${newAccountId} (${entry.slug})` +
        (dryRun ? " [DRY RUN]" : " [WRITING]")
    );

    if (!dryRun) {
      await db
        .update(tickets)
        .set({
          accountId: newAccountId,
          originClass: "client",
        })
        .where(eq(tickets.id, ticket.id));
    }

    reclassified++;
  }

  console.log(
    `[reclassify-unrouted] Done. reclassified=${reclassified} still-unknown=${stillUnknown}` +
      (dryRun ? " (dry run — no writes)" : "")
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("[reclassify-unrouted] Fatal:", err);
  process.exit(1);
});
