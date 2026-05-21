// dispatch — stub-feeder adapter
//
// Hand-shaped event adapter for tests and demo.
// Accepts a partial IngestionEvent and fills in defaults.
// Used by POST /api/ingest/stub (auth class c — Clerk-admin only).
//
// plan §Slice 4

import type { IngestionEvent } from "../types.js";

export interface StubEventInput {
  channelId: string;
  /** Defaults to Date.now() as a string if omitted */
  eventTs?: string;
  /** Set to provide a thread reply; omit for a top-level message */
  threadTs?: string;
  /** Defaults to 'U_STUB_AUTHOR' */
  authorRef?: string;
  /** Defaults to 'Stub event body' */
  body?: string;
  /** Optional: 'channel' | 'dm' | 'group-dm' | 'email' — defaults to 'channel' */
  sourceKind?: "channel" | "dm" | "group-dm" | "email";
  /** For group-DM stubs: participant Slack user ids */
  participantUserIds?: string[];
}

/**
 * Normalize a stub event input into a typed IngestionEvent.
 * Used by the POST /api/ingest/stub handler.
 */
export function normalizeStubEvent(input: StubEventInput): IngestionEvent {
  const eventTs = input.eventTs ?? `${Date.now()}.000000`;
  const threadTs = input.threadTs ?? null;
  const isTopLevel = !threadTs || threadTs === eventTs;

  return {
    source: "stub",
    channelId: input.channelId,
    eventTs,
    threadTs: isTopLevel ? null : threadTs,
    authorRef: input.authorRef ?? "U_STUB_AUTHOR",
    body: input.body ?? "Stub event body",
    isTopLevel,
    sourceKind: input.sourceKind,
    participantUserIds: input.participantUserIds,
  };
}
