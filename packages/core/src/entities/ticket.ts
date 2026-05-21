// dispatch — Ticket entity: Zod schema + types
// A Ticket is one unit of client work.
// See plan §2 for the full column spec.

import { z } from "zod";

export const TicketStatusSchema = z.enum([
  "new",
  "on-you",
  "waiting-client",
  "follow-up-required",
  "follow-up-1-sent",
  "closeout",
  "closed",
  "complete",
]);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const TicketTypeSchema = z.enum([
  "question",
  "reply",
  "thanks",
  "ooo",
  "other",
]);
export type TicketType = z.infer<typeof TicketTypeSchema>;

export const EffortBucketSchema = z
  .enum(["client-specific", "platform-shared", "one-time-build"])
  .nullable();
export type EffortBucket = z.infer<typeof EffortBucketSchema>;

export const SourceKindSchema = z.enum([
  "channel",
  "dm",
  "group-dm",
  "email",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const OriginClassSchema = z.enum(["client", "internal", "unknown"]);
export type OriginClass = z.infer<typeof OriginClassSchema>;

export const TicketSchema = z.object({
  id: z.string().uuid(),
  displayId: z.string(),
  accountId: z.string().uuid(),
  status: TicketStatusSchema,
  type: TicketTypeSchema,
  assignee: z.string().nullable(),
  effortBucket: EffortBucketSchema,
  sourceKind: SourceKindSchema,
  sourceChannelId: z.string().nullable().optional(),
  sourceEventTs: z.string().nullable().optional(),
  originClass: OriginClassSchema,
  openedAt: z.string().datetime(),
  firstResponseAt: z.string().datetime().nullable().optional(),
  followUp1SentAt: z.string().datetime().nullable().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
  slaDeadline: z.string().datetime().nullable().optional(),
  slaPaused: z.boolean(),
  dismissedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type TicketDto = z.infer<typeof TicketSchema>;

// The board card shape — includes denormalized Account fields
export const TicketCardSchema = TicketSchema.extend({
  clientName: z.string(),
  clientHealth: z.enum(["good", "risk", "crit"]),
  preview: z.string(), // first 160 chars of the first message body
  ageMin: z.number(), // minutes since openedAt
  slaMin: z.number().nullable(), // minutes until sla_deadline; null = no SLA; negative = overdue
  paused: z.boolean(),
});

export type TicketCard = z.infer<typeof TicketCardSchema>;

// Query parameters for GET /api/tickets
export const TicketListQuerySchema = z.object({
  status: TicketStatusSchema.optional(),
  assignee: z.string().optional(),
  accountId: z.string().optional(),
  type: TicketTypeSchema.optional(),
  originClass: OriginClassSchema.optional(),
  sort: z.enum(["sla", "age-desc", "age-asc", "client"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;
