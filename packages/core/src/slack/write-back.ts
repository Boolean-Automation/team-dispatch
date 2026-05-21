// dispatch — Slack write-back client
//
// Fires chat.postMessage to the originating Slack channel, posted as the
// sending SE's own Slack user.
//
// OQ-2 RESOLVED (operator decision, 2026-05-21): write-back uses **per-SE
// Slack user tokens** — each SE authorizes a Slack user token and replies
// post literally AS that SE's real Slack user (true authorship). This is the
// heavier-auth option vs. a bot posting attributed-to-the-SE; the operator
// chose it deliberately. See plan.md §4 OQ-2 / §8.
//
// Token resolution: per-SE, keyed by Clerk user id, from the environment —
// `SLACK_USER_TOKEN_<clerkUserId>`. One token per operator. A reply whose SE
// has no configured token fails gracefully (the outbox row moves to 'failed'
// with a clear last_error) — it never crashes the worker.
//
// Because the message is genuinely authored by the SE's own user, no
// username/icon_url attribution override is needed (those only apply to bot
// tokens). They are retained on the payload as display metadata.
//
// plan §Slice 5 / spec §3.7 / OQ-2

import { WebClient } from "@slack/web-api";

export interface PostReplyPayload {
  /** Slack channel id to post into */
  channelId: string;
  /** Text body of the reply */
  text: string;
  /** Slack thread ts to post as a reply thread, if any */
  threadTs?: string;
  /** Clerk user id of the SE sending the reply — resolves the per-SE token */
  actorId: string;
  /** Display name of the SE (retained as metadata; not used for attribution) */
  username?: string;
  /** SE avatar URL (retained as metadata; not used for attribution) */
  iconUrl?: string;
}

export interface PostReplyResult {
  /** True if the send succeeded */
  ok: boolean;
  /** Slack message ts — present on success */
  ts?: string;
  /** Error message on failure */
  error?: string;
}

// ── Slack poster boundary ──────────────────────────────────────────────────────
//
// The real poster constructs a @slack/web-api WebClient with the SE's user
// token and calls chat.postMessage. Tests inject a fake via
// _setSlackPosterForTest so no live Slack call is ever made in a test.

export interface SlackPostArgs {
  channel: string;
  text: string;
  thread_ts?: string;
}

export type SlackPosterFn = (
  token: string,
  args: SlackPostArgs
) => Promise<PostReplyResult>;

const realPoster: SlackPosterFn = async (token, args) => {
  const client = new WebClient(token);
  const result = await client.chat.postMessage({
    channel: args.channel,
    text: args.text,
    ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
  });
  return { ok: result.ok ?? false, ts: result.ts };
};

let _poster: SlackPosterFn | null = null;

/** Inject a fake Slack poster for tests — replaces the real WebClient call. */
export function _setSlackPosterForTest(fn: SlackPosterFn): void {
  _poster = fn;
}

/** Reset to the real WebClient-backed poster after tests. */
export function _resetSlackPoster(): void {
  _poster = null;
}

/** Resolve the per-SE Slack user token from the environment. */
export function resolveSlackUserToken(actorId: string): string | undefined {
  if (!actorId) return undefined;
  return process.env[`SLACK_USER_TOKEN_${actorId}`];
}

/**
 * Post a reply to a Slack channel, as the sending SE's own Slack user.
 *
 * Resolves the SE's per-SE user token (OQ-2: per-SE Slack user tokens). When
 * no token is configured for that SE the send fails gracefully with a clear
 * error — the caller (outbox worker) moves the row to 'failed', never crashes.
 *
 * The outbox worker calls this function; it is the single send boundary.
 */
export async function postReply(
  payload: PostReplyPayload
): Promise<PostReplyResult> {
  const token = resolveSlackUserToken(payload.actorId);
  if (!token) {
    return {
      ok: false,
      error: `no Slack user token configured for SE ${payload.actorId || "(unknown)"} — set SLACK_USER_TOKEN_${payload.actorId || "<clerkUserId>"} in the environment`,
    };
  }

  const poster = _poster ?? realPoster;

  try {
    return await poster(token, {
      channel: payload.channelId,
      text: payload.text,
      ...(payload.threadTs ? { thread_ts: payload.threadTs } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
