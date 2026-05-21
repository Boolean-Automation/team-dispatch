// dispatch — Slack write-back client
//
// Fires chat.postMessage to the originating Slack channel, attributed to the
// sending SE via username + icon_url (bot-attributed, not user-token posting).
//
// ⚠️  OQ-2 HARD GATE — the live chat.postMessage call is STUBBED.
// The actual HTTP call is replaced with a TODO until the operator signs off on
// the write-back identity mechanism (which bot token, how attribution works).
// See plan.md §4 OQ-2 and §8.
//
// Everything else in this module is real: the interface, the payload shape, the
// error wrapping. Wiring the live call is a one-function change in postReply().
//
// plan §Slice 5 / spec §3.7 / OQ-2

export interface PostReplyPayload {
  /** Slack channel id to post into */
  channelId: string;
  /** Text body of the reply */
  text: string;
  /** Slack thread ts to post as a reply thread, if any */
  threadTs?: string;
  /** Display name to attribute the post to (SE's name) */
  username: string;
  /** URL of the SE's avatar icon */
  iconUrl?: string;
}

export interface PostReplyResult {
  /** True if the send succeeded (or was simulated by stub) */
  ok: boolean;
  /** Slack message ts — present on real success; stub returns a simulated ts */
  ts?: string;
  /** Error message on failure */
  error?: string;
}

/**
 * Post a reply to a Slack channel, attributed to the given SE.
 *
 * TODO(OQ-2): wire live chat.postMessage once operator picks write-back
 * identity mechanism — see plan.md §8.
 *
 * Currently stubbed: logs the payload and returns a simulated success result.
 * The outbox worker calls this function; only this function changes when the
 * live send is wired.
 */
export async function postReply(
  payload: PostReplyPayload
): Promise<PostReplyResult> {
  // TODO(OQ-2): replace this stub with live chat.postMessage once the operator
  // decides on the write-back identity mechanism (bot token, attribution).
  // Recommended: WebClient from @slack/web-api with a bot token, posting with
  // username and icon_url set to the SE's dispatch identity.
  //
  // Example real implementation (do not uncomment until OQ-2 is resolved):
  //
  //   const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  //   const result = await client.chat.postMessage({
  //     channel: payload.channelId,
  //     text: payload.text,
  //     thread_ts: payload.threadTs,
  //     username: payload.username,
  //     icon_url: payload.iconUrl,
  //   });
  //   return { ok: true, ts: result.ts };
  //
  // For now: log and return a stub result. The row moves to 'sent' in the worker
  // using this stub result — making the full lifecycle testable without a real token.

  console.log(
    `[write-back STUB] OQ-2 pending — would post to ${payload.channelId} as "${payload.username}": ${payload.text.slice(0, 80)}...`
  );

  return {
    ok: true,
    ts: `stub-${Date.now()}.000000`,
  };
}
