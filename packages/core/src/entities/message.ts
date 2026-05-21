// dispatch — Message entity: Zod schema + types
// A Message is a single inbound or outbound communication on a Ticket.
// Thread replies are Messages on the parent Ticket — never a new Ticket.

import { z } from "zod";

export const MessageDirectionSchema = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const AuthorKindSchema = z.enum(["client", "se"]);
export type AuthorKind = z.infer<typeof AuthorKindSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  direction: MessageDirectionSchema,
  authorKind: AuthorKindSchema,
  authorRef: z.string(), // Slack user id (client) or Clerk user id (se)
  body: z.string(),
  slackTs: z.string().nullable().optional(),
  postedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export type MessageDto = z.infer<typeof MessageSchema>;
