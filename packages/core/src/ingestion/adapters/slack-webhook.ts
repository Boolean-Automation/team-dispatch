// dispatch — Slack Events-API webhook adapter
//
// Normalizes a Slack Events-API payload → IngestionEvent.
// This adapter handles:
//   - url_verification challenge (returns the challenge string)
//   - message events: top-level channel messages + thread replies
//
// plan §Slice 4: auth class (b) — Slack HMAC signature verification lives in
// the clerk-auth plugin (requireSlackSignature). This adapter is responsible
// only for payload normalization.
//
// Reference: https://api.slack.com/apis/connections/events-api

import type { IngestionEvent } from "../types.js";

// ── Slack payload shapes ──────────────────────────────────────────────────────

export interface SlackUrlVerificationPayload {
  type: "url_verification";
  challenge: string;
  token: string;
}

export interface SlackEventCallback {
  type: "event_callback";
  event_id: string;
  event: SlackMessageEvent | SlackOtherEvent;
  [key: string]: unknown;
}

export interface SlackMessageEvent {
  type: "message";
  channel: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  [key: string]: unknown;
}

export interface SlackOtherEvent {
  type: string;
  [key: string]: unknown;
}

export type SlackWebhookPayload =
  | SlackUrlVerificationPayload
  | SlackEventCallback
  | Record<string, unknown>;

// ── Adapter result types ──────────────────────────────────────────────────────

export type SlackAdapterResult =
  | { kind: "url_verification"; challenge: string }
  | { kind: "event"; event: IngestionEvent }
  | { kind: "ignored"; reason: string };

// ── normalizeSlackPayload ──────────────────────────────────────────────────────

/**
 * Normalize a Slack Events-API payload into an IngestionEvent.
 *
 * Returns:
 *   { kind: 'url_verification', challenge } — for the Slack URL handshake
 *   { kind: 'event', event }               — for a message event
 *   { kind: 'ignored', reason }            — for non-message events / bot messages
 */
export function normalizeSlackPayload(
  payload: SlackWebhookPayload
): SlackAdapterResult {
  const p = payload as Record<string, unknown>;

  // url_verification handshake
  if (p["type"] === "url_verification") {
    const challenge = p["challenge"];
    if (typeof challenge !== "string") {
      return { kind: "ignored", reason: "url_verification missing challenge" };
    }
    return { kind: "url_verification", challenge };
  }

  // Only handle event_callback
  if (p["type"] !== "event_callback") {
    return { kind: "ignored", reason: `unhandled type: ${String(p["type"])}` };
  }

  const event = p["event"] as Record<string, unknown> | undefined;
  if (!event) {
    return { kind: "ignored", reason: "missing event field" };
  }

  // Only handle message events
  if (event["type"] !== "message") {
    return {
      kind: "ignored",
      reason: `non-message event type: ${String(event["type"])}`,
    };
  }

  // Skip bot messages (Slack sends bot messages with bot_id set, no user)
  if (event["bot_id"] && !event["user"]) {
    return { kind: "ignored", reason: "bot message" };
  }

  // Skip message_changed / message_deleted subtypes
  const subtype = event["subtype"];
  if (subtype && subtype !== "thread_broadcast") {
    return {
      kind: "ignored",
      reason: `message subtype: ${String(subtype)}`,
    };
  }

  const channel = event["channel"];
  const ts = event["ts"];
  const threadTs = event["thread_ts"];
  const user = event["user"];
  const text = event["text"];

  if (typeof channel !== "string" || typeof ts !== "string") {
    return { kind: "ignored", reason: "missing channel or ts" };
  }

  const authorRef = typeof user === "string" ? user : "unknown";
  const body = typeof text === "string" ? text : "";

  // A message is a thread reply if thread_ts is set AND thread_ts !== ts
  // (when thread_ts === ts it's the top-level message that started the thread)
  const isReply =
    typeof threadTs === "string" && threadTs !== ts;

  const ingestionEvent: IngestionEvent = {
    source: "slack",
    channelId: channel,
    eventTs: ts,
    threadTs: isReply ? (threadTs as string) : null,
    authorRef,
    body,
    isTopLevel: !isReply,
  };

  return { kind: "event", event: ingestionEvent };
}
