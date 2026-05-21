// dispatch — Account entity: Zod schema + types
// An Account is a client. It maps to one registry entry and one accounts DB row.

import { z } from "zod";

export const AccountHealthSchema = z.enum(["good", "risk", "crit"]);
export type AccountHealth = z.infer<typeof AccountHealthSchema>;

export const AccountSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1).max(64),
  displayName: z.string().min(1),
  emailDomains: z.array(z.string()),
  slackChannelIds: z.array(z.string()),
  owningSe: z.string().nullable(),
  health: AccountHealthSchema,
  highlights: z.string().nullable().optional(),
  highlightsSourcePath: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AccountDto = z.infer<typeof AccountSchema>;

// Minimal shape for board rendering (denormalized from the JOIN)
export const AccountSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  health: AccountHealthSchema,
  owningSe: z.string().nullable(),
});

export type AccountSummary = z.infer<typeof AccountSummarySchema>;
