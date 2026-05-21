// dispatch — contact-service: read-side service
//
// All Contact reads go through here.
// Contacts are auto-discovered (not hand-maintained).

import { eq } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { contacts } from "@dispatch/db";
import type { ContactDto } from "../entities/contact.js";

function toDto(row: typeof contacts.$inferSelect): ContactDto {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name ?? null,
    email: row.email ?? null,
    slackUserId: row.slackUserId ?? null,
    role: row.role ?? null,
    discoveredVia: row.discoveredVia as ContactDto["discoveredVia"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listContacts(db: Db): Promise<ContactDto[]> {
  const rows = await db.select().from(contacts).orderBy(contacts.createdAt);
  return rows.map(toDto);
}

export async function listContactsByAccount(
  db: Db,
  accountId: string
): Promise<ContactDto[]> {
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.accountId, accountId))
    .orderBy(contacts.createdAt);
  return rows.map(toDto);
}

export async function getContact(
  db: Db,
  id: string
): Promise<ContactDto | null> {
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, id))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

export async function getContactBySlackUserId(
  db: Db,
  slackUserId: string
): Promise<ContactDto | null> {
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.slackUserId, slackUserId))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}
