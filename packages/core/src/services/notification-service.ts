// dispatch — notification-service
//
// notifications table writes + reads for the topbar bell center.
// Built incrementally: table populated here in Slice 4 (ticket.assigned),
// extended in Slices 6+7 for follow-up-required and reassignment notifications.
//
// plan §Slice 4 / §3 cross-cutting concerns / spec §3.11

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { notifications } from "@dispatch/db";
import type { Notification } from "@dispatch/db";

export type NotificationKind =
  | "reassignment-incoming"
  | "reassignment-accepted"
  | "reassignment-rejected"
  | "follow-up-required"
  | "closeout-required"
  | "reinforcement-added"
  | "ticket-assigned";

export interface CreateNotificationOptions {
  recipientId: string;
  kind: NotificationKind;
  ticketId?: string | null;
  payload?: Record<string, unknown> | null;
}

/** Create a notification row for a recipient. */
export async function createNotification(
  db: Db,
  opts: CreateNotificationOptions
): Promise<Notification> {
  const rows = await db
    .insert(notifications)
    .values({
      recipientId: opts.recipientId,
      kind: opts.kind,
      ticketId: opts.ticketId ?? null,
      payload: opts.payload ?? null,
    })
    .returning();
  return rows[0]!;
}

/** List unread notifications for a recipient (readAt IS NULL), newest first. */
export async function listUnreadNotifications(
  db: Db,
  recipientId: string
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientId, recipientId),
        isNull(notifications.readAt)
      )
    )
    .orderBy(notifications.createdAt);
}

/** List all notifications for a recipient (read + unread), newest first. */
export async function listNotifications(
  db: Db,
  recipientId: string
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientId, recipientId))
    .orderBy(notifications.createdAt);
}

/** Mark a notification as read. */
export async function markNotificationRead(
  db: Db,
  notificationId: string
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(eq(notifications.id, notificationId));
}
