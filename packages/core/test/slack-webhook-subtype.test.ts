// dispatch — Slack adapter subtype policy
//
// Regression: a client message that includes a file upload arrives with
// subtype "file_share". The adapter used to ignore every subtype except
// "thread_broadcast", so file-bearing client messages (screenshots of what's
// wrong) were silently dropped — the message AND its downstream thread
// (orphan-replies) never reached the board. This pins the allow-list.
//
// Pure unit test: normalizeSlackPayload has no DB dependency.

import { describe, it, expect } from "vitest";
import { normalizeSlackPayload } from "../src/ingestion/adapters/slack-webhook.js";

function event(extra: Record<string, unknown>) {
  return {
    type: "event_callback",
    event_id: "Ev_TEST",
    event: {
      type: "message",
      channel: "C07QHC7JKH9",
      channel_type: "channel",
      user: "U07EGCC7Y7K",
      text: "here are three duplicate change orders",
      ts: "1782315159.657269",
      ...extra,
    },
  };
}

describe("normalizeSlackPayload — subtype policy", () => {
  it("ingests a file_share message as a normal top-level event", () => {
    const result = normalizeSlackPayload(event({ subtype: "file_share" }));
    expect(result.kind).toBe("event");
    if (result.kind === "event") {
      expect(result.event.isTopLevel).toBe(true);
      expect(result.event.authorRef).toBe("U07EGCC7Y7K");
      expect(result.event.channelId).toBe("C07QHC7JKH9");
    }
  });

  it("still ingests a plain message (no subtype)", () => {
    expect(normalizeSlackPayload(event({})).kind).toBe("event");
  });

  it("still ingests thread_broadcast", () => {
    const r = normalizeSlackPayload(
      event({ subtype: "thread_broadcast", thread_ts: "1782313181.474949" })
    );
    expect(r.kind).toBe("event");
  });

  it("still ignores noise subtypes (message_changed, channel_join, …)", () => {
    for (const subtype of ["message_changed", "message_deleted", "channel_join"]) {
      const r = normalizeSlackPayload(event({ subtype }));
      expect(r.kind).toBe("ignored");
    }
  });
});
