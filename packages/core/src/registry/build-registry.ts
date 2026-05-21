// dispatch — registry builder
//
// Reads boolean-knowledge/clients/_registry.yaml by ABSOLUTE PATH.
// Returns typed RegistryEntry[] for use by the db seed and ingestion classifier.
//
// The registry is a hand-maintained structured YAML file — it is NOT derived
// by parsing client profile.md prose at runtime. The dangerous pattern (re-parsing
// markdown on every run) silently drifts when a profile is reworded; a mis-parsed
// channel id mis-classifies a real client issue as internal noise.
//
// The builder:
//   1. Reads and parses _registry.yaml (YAML → JS object).
//   2. Validates with Zod (unknown fields are stripped, required fields enforced).
//   3. Returns RegistryEntry[] — one entry per client.
//
// For origin classification, consumers use:
//   classifyOrigin(channelId, registry) → 'client' | 'internal' | 'unknown'

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const RegistryEntrySchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().min(1),
  email_domains: z.array(z.string()).default([]),
  slack_channel_ids: z.array(z.string()).default([]),
  owning_se: z.string().nullable().optional(),
});

const RegistrySchema = z.object({
  clients: z.array(RegistryEntrySchema),
  // Optional: channels that are explicitly registered as Boolean-internal.
  // A message in one of these channels produces NO ticket (spec §5.1, A10).
  internal_channel_ids: z.array(z.string()).default([]),
});

type RawRegistry = z.infer<typeof RegistrySchema>;

// ── Public types ──────────────────────────────────────────────────────────────

export interface RegistryEntry {
  slug: string;
  displayName: string;
  emailDomains: string[];
  slackChannelIds: string[];
  owningSe: string | null | undefined;
}

export interface ParsedRegistry {
  clients: RegistryEntry[];
  internalChannelIds: string[];
}

// ── buildRegistry ─────────────────────────────────────────────────────────────
//
// Reads and validates _registry.yaml at the given absolute path.
// Returns the entries array (for seed / convenience callers).
// Use parseRegistry() if you also need the internal_channel_ids list.

export function buildRegistry(registryPath: string): RegistryEntry[] {
  return parseRegistry(registryPath).clients;
}

// ── parseRegistry ─────────────────────────────────────────────────────────────
//
// Full parse: returns both clients[] and internalChannelIds[].

export function parseRegistry(registryPath: string): ParsedRegistry {
  const absPath = path.resolve(registryPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Registry file not found: ${absPath}`);
  }

  const raw = yaml.load(fs.readFileSync(absPath, "utf8")) as unknown;

  let validated: RawRegistry;
  try {
    validated = RegistrySchema.parse(raw);
  } catch (err) {
    throw new Error(`Invalid _registry.yaml: ${String(err)}`);
  }

  const clients: RegistryEntry[] = validated.clients.map((entry) => ({
    slug: entry.slug,
    displayName: entry.display_name,
    emailDomains: entry.email_domains,
    slackChannelIds: entry.slack_channel_ids,
    owningSe: entry.owning_se ?? null,
  }));

  return {
    clients,
    internalChannelIds: validated.internal_channel_ids,
  };
}

// ── classifyOrigin ─────────────────────────────────────────────────────────────
//
// Classifies a Slack channel id against the parsed registry.
//
// Returns:
//   'client'   — channel id is present in a registry entry's slack_channel_ids[]
//   'internal' — channel id is in internal_channel_ids[]
//   'unknown'  — channel id matches NO registry entry
//
// The 'unknown' path is deliberately NEVER treated as 'internal' — an unknown
// origin still creates a Ticket (unassigned, origin_class='unknown') for admin
// triage. Only an explicitly registered internal channel produces no Ticket.
//
// Email-domain classification is handled by classifyEmailDomain().

export type RegistryOriginClass = "client" | "internal" | "unknown";

export function classifyOrigin(
  channelId: string,
  registry: ParsedRegistry
): { originClass: RegistryOriginClass; entry?: RegistryEntry } {
  if (!channelId) return { originClass: "unknown" };

  // Check internal channels first (Slack noise — no Ticket)
  if (registry.internalChannelIds.includes(channelId)) {
    return { originClass: "internal" };
  }

  // Check client channels
  for (const entry of registry.clients) {
    if (entry.slackChannelIds.includes(channelId)) {
      return { originClass: "client", entry };
    }
  }

  // Matches nothing — unknown origin (loud classification)
  return { originClass: "unknown" };
}

// ── classifyEmailDomain ───────────────────────────────────────────────────────
//
// Classifies an email address by its domain against the registry.
// Returns the matching RegistryEntry or undefined.

export function classifyEmailDomain(
  email: string,
  registry: ParsedRegistry
): RegistryEntry | undefined {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return undefined;

  return registry.clients.find((entry) =>
    entry.emailDomains.some((d) => d.toLowerCase() === domain)
  );
}
