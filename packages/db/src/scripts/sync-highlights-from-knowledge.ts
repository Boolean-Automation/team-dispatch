// dispatch — sync-highlights-from-knowledge
//
// Reads boolean-knowledge/clients/<slug>/_summary.yaml (fallback: profile.md
// first 5 lines after YAML frontmatter) and upserts accounts.highlights +
// highlights_source_path + highlights_synced_at.
//
// Idempotency: skips rows where accounts.updated_at > highlights_synced_at
// (operator edit via PATCH /api/accounts/:id/highlights wins over script write).
//
// Usage:
//   DATABASE_URL=... KNOWLEDGE_ROOT=~/boolean-knowledge \
//     tsx packages/db/src/scripts/sync-highlights-from-knowledge.ts [--dry-run] [--commit]
//
// Flags:
//   --dry-run  (default) prints what would be written, no DB writes.
//   --commit   performs the upserts.
//
// KNOWLEDGE_ROOT defaults to process.env.BOOLEAN_KNOWLEDGE_ROOT or
// path.resolve(process.cwd(), '../../boolean-knowledge').

import fs from "node:fs";
import path from "node:path";
import { eq, sql, and, gt, isNotNull } from "drizzle-orm";
import { createDb } from "../client.js";
import { accounts } from "../schema.js";

const HIGHLIGHTS_MAX_CHARS = 500;

// ── YAML frontmatter stripper ─────────────────────────────────────────────────

function stripFrontmatter(content: string): string {
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end !== -1) {
      return content.slice(end + 4).trimStart();
    }
  }
  return content;
}

// ── Word-boundary truncation ──────────────────────────────────────────────────

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Find the last word boundary before maxChars
  const sub = text.slice(0, maxChars);
  const lastSpace = sub.lastIndexOf(" ");
  const cut = lastSpace > 0 ? lastSpace : maxChars;
  return text.slice(0, cut) + "…";
}

// ── Source reader: summary.yaml → profile.md fallback ─────────────────────────

interface HighlightsSource {
  content: string;
  sourcePath: string;
}

function readHighlightsForSlug(knowledgeRoot: string, slug: string): HighlightsSource | null {
  const clientDir = path.join(knowledgeRoot, "clients", slug);

  if (!fs.existsSync(clientDir)) {
    return null;
  }

  // 1. Try _summary.yaml — look for a highlights: key
  const summaryPath = path.join(clientDir, "_summary.yaml");
  if (fs.existsSync(summaryPath)) {
    const raw = fs.readFileSync(summaryPath, "utf-8");
    // Simple key: value extraction (no full YAML parser needed for this shape)
    const hlMatch = raw.match(/^highlights:\s*["']?([\s\S]+?)["']?\s*$/m);
    if (hlMatch && hlMatch[1]?.trim()) {
      const content = truncateAtWord(hlMatch[1].trim(), HIGHLIGHTS_MAX_CHARS);
      return { content, sourcePath: `clients/${slug}/_summary.yaml` };
    }

    // _summary.yaml exists but has no highlights key — check if it has
    // a description: key as a fallback
    const descMatch = raw.match(/^description:\s*["']?([\s\S]+?)["']?\s*$/m);
    if (descMatch && descMatch[1]?.trim()) {
      const content = truncateAtWord(descMatch[1].trim(), HIGHLIGHTS_MAX_CHARS);
      return { content, sourcePath: `clients/${slug}/_summary.yaml` };
    }
  }

  // 2. Fall back to profile.md — first 5 lines after YAML frontmatter
  const profilePath = path.join(clientDir, "profile.md");
  if (fs.existsSync(profilePath)) {
    const raw = fs.readFileSync(profilePath, "utf-8");
    const body = stripFrontmatter(raw);
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 5)
      .join("\n");
    if (lines) {
      const content = truncateAtWord(lines, HIGHLIGHTS_MAX_CHARS);
      return { content, sourcePath: `clients/${slug}/profile.md` };
    }
  }

  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = !process.argv.includes("--commit");
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("[sync-highlights] DATABASE_URL is required");
    process.exit(1);
  }

  const knowledgeRoot =
    process.env.BOOLEAN_KNOWLEDGE_ROOT ??
    process.env.KNOWLEDGE_ROOT ??
    path.resolve(process.cwd(), "../../boolean-knowledge");

  console.log(
    `[sync-highlights] ${dryRun ? "DRY RUN — " : ""}Knowledge root: ${knowledgeRoot}`
  );

  if (!fs.existsSync(knowledgeRoot)) {
    console.error(`[sync-highlights] Knowledge root not found: ${knowledgeRoot}`);
    process.exit(1);
  }

  const db = createDb(databaseUrl);

  // Load all accounts
  const allAccounts = await db
    .select({
      id: accounts.id,
      slug: accounts.slug,
      displayName: accounts.displayName,
      updatedAt: accounts.updatedAt,
      highlightsSyncedAt: accounts.highlightsSyncedAt,
    })
    .from(accounts);

  console.log(`[sync-highlights] Found ${allAccounts.length} account(s)`);

  let synced = 0;
  let skipped = 0;
  let noSource = 0;
  let operatorOverride = 0;

  for (const acct of allAccounts) {
    // Skip the __unrouted__ quarantine account
    if (acct.slug === "__unrouted__") {
      skipped++;
      continue;
    }

    // Skip rows where operator edit is more recent than last sync
    if (
      acct.highlightsSyncedAt &&
      acct.updatedAt > acct.highlightsSyncedAt
    ) {
      console.log(`[sync-highlights] SKIP (operator override) ${acct.slug}`);
      operatorOverride++;
      continue;
    }

    const source = readHighlightsForSlug(knowledgeRoot, acct.slug);

    if (!source) {
      console.log(`[sync-highlights] SKIP (no source) ${acct.slug}`);
      noSource++;
      continue;
    }

    console.log(
      `[sync-highlights] ${dryRun ? "WOULD WRITE" : "WRITING"} ${acct.slug} ` +
        `(${source.content.length} chars from ${source.sourcePath})`
    );

    if (!dryRun) {
      await db
        .update(accounts)
        .set({
          highlights: source.content,
          highlightsSourcePath: source.sourcePath,
          highlightsSyncedAt: new Date(),
        })
        .where(eq(accounts.id, acct.id));
    }

    synced++;
  }

  console.log(
    `[sync-highlights] Done. synced=${synced} skipped=${skipped} ` +
      `no-source=${noSource} operator-override=${operatorOverride}` +
      (dryRun ? " (dry run — no writes)" : "")
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("[sync-highlights] Fatal:", err);
  process.exit(1);
});
