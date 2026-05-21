// dispatch — write-back unit tests
//
// Covers the OQ-2 per-SE-Slack-user-token send path (no DB, no live Slack).
//
// Tests:
//  1. postReply with no configured token → ok=false, clear error.
//  2. postReply with a configured token → injected poster receives the token
//     and post args, returns ok=true.
//  3. postReply when the poster throws → ok=false, error wrapped (no crash).
//  4. resolveSlackUserToken reads SLACK_USER_TOKEN_<actorId> from the env.

import { describe, it, expect, afterEach } from "vitest";
import {
  postReply,
  resolveSlackUserToken,
  _setSlackPosterForTest,
  _resetSlackPoster,
  type SlackPostArgs,
} from "../src/slack/write-back.js";

const SE_ID = "user_writeback_test";
const ENV_KEY = `SLACK_USER_TOKEN_${SE_ID}`;

afterEach(() => {
  _resetSlackPoster();
  delete process.env[ENV_KEY];
});

describe("resolveSlackUserToken", () => {
  it("reads SLACK_USER_TOKEN_<actorId> from the environment", () => {
    process.env[ENV_KEY] = "xoxp-test-token";
    expect(resolveSlackUserToken(SE_ID)).toBe("xoxp-test-token");
  });

  it("returns undefined when no token is configured", () => {
    expect(resolveSlackUserToken(SE_ID)).toBeUndefined();
  });

  it("returns undefined for an empty actorId", () => {
    expect(resolveSlackUserToken("")).toBeUndefined();
  });
});

describe("postReply", () => {
  it("fails gracefully when the SE has no configured token", async () => {
    const result = await postReply({
      channelId: "C_TEST_001",
      text: "hello",
      actorId: SE_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no Slack user token configured");
    expect(result.error).toContain(SE_ID);
  });

  it("posts via the resolved per-SE token and returns ok on success", async () => {
    process.env[ENV_KEY] = "xoxp-real-token";
    let seenToken: string | undefined;
    let seenArgs: SlackPostArgs | undefined;
    _setSlackPosterForTest(async (token, args) => {
      seenToken = token;
      seenArgs = args;
      return { ok: true, ts: "1779999999.000100" };
    });

    const result = await postReply({
      channelId: "C_TEST_001",
      text: "the reply body",
      threadTs: "1779999000.000001",
      actorId: SE_ID,
    });

    expect(seenToken).toBe("xoxp-real-token");
    expect(seenArgs).toEqual({
      channel: "C_TEST_001",
      text: "the reply body",
      thread_ts: "1779999000.000001",
    });
    expect(result.ok).toBe(true);
    expect(result.ts).toBe("1779999999.000100");
  });

  it("wraps a poster exception as ok=false (worker never crashes)", async () => {
    process.env[ENV_KEY] = "xoxp-real-token";
    _setSlackPosterForTest(async () => {
      throw new Error("slack rate_limited");
    });

    const result = await postReply({
      channelId: "C_TEST_001",
      text: "hello",
      actorId: SE_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("slack rate_limited");
  });
});
