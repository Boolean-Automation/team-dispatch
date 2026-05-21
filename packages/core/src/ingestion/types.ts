// dispatch — ingestion types
//
// IngestionEvent: the source-agnostic interface all adapters produce.
// plan §Slice 4 — A13: webhook and stub feeder are interchangeable behind this contract.

export interface IngestionEvent {
  /** 'slack' | 'stub' — identifies the adapter source */
  source: "slack" | "stub";
  /** Slack channel id (or synthetic id for non-channel sources like DMs) */
  channelId: string;
  /** Slack event/message timestamp — the persisted dedup key */
  eventTs: string;
  /** For thread replies: the ts of the parent top-level message */
  threadTs?: string | null;
  /** Author identifier (Slack user id for Slack; synthetic for stub) */
  authorRef: string;
  /** Message body text */
  body: string;
  /** true = top-level message; false = thread reply */
  isTopLevel: boolean;
}
