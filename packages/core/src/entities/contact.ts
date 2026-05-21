// dispatch — Contact entity: Zod schema + types
// A Contact is a person at a client. Auto-discovered, not hand-maintained.

import { z } from "zod";

export const DiscoveredViaSchema = z.enum([
  "channel-membership",
  "email-domain",
]);
export type DiscoveredVia = z.infer<typeof DiscoveredViaSchema>;

export const ContactSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  slackUserId: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  discoveredVia: DiscoveredViaSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ContactDto = z.infer<typeof ContactSchema>;
