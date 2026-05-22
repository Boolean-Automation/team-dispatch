// dispatch — Ticket Detail page (Slice 5: full detail surface)
//
// Phase-1 scope per surface-map Surface 3:
//   - TicketStrip (left sidebar with strip items)
//   - TicketHeader (NO clock/billable controls)
//   - TicketTabs (Chat / Internal thread / Linked)
//   - Highlights box (Account Highlights, human-curated)
//   - ChatThread (messages from API)
//   - Composer (reply, no AI draft)
//   - RightPanel + RToolbar (info + activity modes; NO terminal)
//
// Data strategy:
//   - Tries the live API (useTicket, useMessages, useTicketActivity, useAccount).
//   - Falls back to fixture data when the API returns 401 or an error
//     (dev mode without Clerk keys — fixture is clearly marked DEV ONLY).
//   - The production path is always API-wired; fixture only activates on error.
//
// reply send: POST /api/tickets/:id/messages → undo toast via useUndoableMutation.

import React, { useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Rail } from "../shell/Rail";
import { TicketStrip } from "./TicketStrip";
import { TicketHeader } from "./TicketHeader";
import { TicketTabs } from "./TicketTabs";
import type { TicketTab } from "./TicketTabs";
import { Highlights } from "./Highlights";
import { ChatThread } from "./ChatThread";
import { InternalThread } from "./InternalThread";
import { RightPanel } from "./RightPanel";
import type { PanelMode } from "./RightPanel";
import { RToolbar } from "./RToolbar";
import { Composer } from "./Composer";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { useTicket, useMessages, useTicketActivity, useAccount } from "../lib/queries.js";
import { useUndoableMutation } from "../lib/use-undoable-mutation.js";
import { apiClient } from "../lib/api-client.js";
import { ENGINEERS } from "../lib/seed";
import type { Ticket } from "../lib/types";
import type { ThreadItem } from "./Message";
import type { ActivityItem } from "./PanelActivity";
import {
  FIXTURE_TICKET,
  FIXTURE_CHAT_THREAD,
  FIXTURE_INTERNAL_THREAD,
  FIXTURE_ACTIVITY,
  FIXTURE_HIGHLIGHTS,
} from "./ticket-detail-fixture.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert API messages to thread items for ChatThread */
function messagesToThreadItems(msgs: ReturnType<typeof useMessages>["data"]): ThreadItem[] {
  if (!msgs || msgs.length === 0) return [];
  const items: ThreadItem[] = [];

  let lastDay = "";
  for (const msg of msgs) {
    const d = new Date(msg.postedAt);
    const dayKey = d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    if (dayKey !== lastDay) {
      items.push({ kind: "day", label: dayKey });
      lastDay = dayKey;
    }
    items.push({
      kind: "msg",
      who: msg.authorKind === "client" ? "client" : "eng",
      from: msg.authorRef,
      role: msg.authorKind === "client" ? "Client" : "you",
      time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
      src: msg.direction === "inbound" ? "slack" : undefined,
      text: msg.body,
    });
  }
  return items;
}

// ── TicketDetailPage ──────────────────────────────────────────────────────────

export function TicketDetailPage() {
  const { displayId } = useParams<{ displayId: string }>();
  const [tab, setTab] = useState<TicketTab>("chat");
  const [panel, setPanel] = useState<PanelMode>("info");
  const [highlights, setHighlights] = useState<string | null>(null);
  const [highlightsSaved, setHighlightsSaved] = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────
  // useTicket uses /api/tickets/:id but our route is by displayId.
  // We pass the displayId to the ticket query (the API accepts both UUID and displayId).
  const ticketQuery = useTicket(displayId ?? "");
  const messagesQuery = useMessages(ticketQuery.data?.id ?? "");
  const activityQuery = useTicketActivity(ticketQuery.data?.id ?? "");
  const accountQuery = useAccount(ticketQuery.data?.accountId ?? "");

  // ── Fixture fallback (DEV ONLY) ────────────────────────────────────────────
  // When the API is unavailable (401 / network error / no Clerk keys in dev),
  // fall back to fixture data so the UI renders visually.
  // Gated on import.meta.env.DEV — Vite statically replaces this with `false`
  // in a production build, so the fixture path can NEVER activate in prod (a
  // real transient API error in production surfaces as an error state, not as
  // silently-fake fixture data). It only triggers in a dev build, when the API
  // errors, AND the displayId matches the known fixture ticket.
  const apiUnavailable =
    import.meta.env.DEV &&
    ticketQuery.isError &&
    displayId === FIXTURE_TICKET.displayId;

  const ticket: Ticket | null =
    ticketQuery.data ?? (apiUnavailable ? FIXTURE_TICKET : null);

  const chatItems: ThreadItem[] =
    apiUnavailable
      ? FIXTURE_CHAT_THREAD
      : messagesToThreadItems(messagesQuery.data);

  const internalItems: ThreadItem[] = apiUnavailable ? FIXTURE_INTERNAL_THREAD : [];

  const activityItems: ActivityItem[] =
    apiUnavailable
      ? FIXTURE_ACTIVITY
      : (activityQuery.data?.map((e) => ({
          id: e.id,
          event: e.event,
          actorId: e.actorId,
          before: e.before as Record<string, unknown> | null,
          after: e.after as Record<string, unknown> | null,
          createdAt: e.createdAt,
        })) ?? []);

  const accountHighlights =
    highlightsSaved
      ? highlights
      : apiUnavailable
      ? FIXTURE_HIGHLIGHTS
      : (accountQuery.data?.highlights ?? null);

  // ── Reply mutation ─────────────────────────────────────────────────────────
  const sendReplyMutation = useUndoableMutation({
    mutationFn: async (vars: { body: string; resolve: boolean }) => {
      if (!ticket?.id) throw new Error("No ticket loaded");
      return apiClient.post<{ message: unknown; undoToken: string; outboxId: string }>(
        `/api/tickets/${ticket.id}/messages`,
        {
          body: vars.body,
          actorName: ENGINEERS["dan"]?.name ?? "Support",
          resolve: vars.resolve,
        }
      );
    },
    toastLabel: "Reply sent (10s undo window)",
    invalidateKeys: [
      ["messages", ticket?.id ?? ""],
      ["ticket", displayId ?? ""],
      ["activity", ticket?.id ?? ""],
    ],
  });

  const handleSend = useCallback(
    (body: string, resolve: boolean) => {
      sendReplyMutation.mutate({ body, resolve });
    },
    [sendReplyMutation]
  );

  // ── Highlights save ────────────────────────────────────────────────────────
  const handleHighlightsSave = useCallback(
    (text: string) => {
      if (!ticket?.id || apiUnavailable) {
        // Dev mode: just update local state
        setHighlights(text);
        setHighlightsSaved(true);
        return;
      }
      // Live mode: PATCH /api/accounts/:id/highlights
      void apiClient.patch(
        `/api/accounts/${ticket.accountId}/highlights`,
        { highlights: text }
      ).then(() => {
        setHighlights(text);
        setHighlightsSaved(true);
      });
    },
    [ticket, apiUnavailable]
  );

  // ── Resolve assignee name ──────────────────────────────────────────────────
  const assigneeKey = ticket?.assignee ?? null;
  const assigneeName = assigneeKey
    ? (ENGINEERS[assigneeKey]?.name ?? assigneeKey)
    : "Unassigned";

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!ticket && ticketQuery.isLoading) {
    return (
      <div className="app detail">
        <Rail current="issues" />
        <div className="detail-body" style={{ display: "flex", alignItems: "center", justifyContent: "center", gridColumn: "2 / -1" }}>
          <span style={{ color: "var(--text-3)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            Loading…
          </span>
        </div>
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="app detail">
        <Rail current="issues" />
        <div className="detail-body" style={{ display: "flex", alignItems: "center", justifyContent: "center", gridColumn: "2 / -1" }}>
          <span style={{ color: "var(--text-3)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            Ticket {displayId} not found
          </span>
        </div>
      </div>
    );
  }

  const channelName = ticket.sourceChannelId
    ? `#${ticket.sourceChannelId.toLowerCase()}`
    : "#channel";

  return (
    <div className="detail">
      <Rail current="issues" />
      <div className="detail-body">
        {/* Left: ticket list strip */}
        <TicketStrip activeDisplayId={ticket.displayId} />

        {/* Center: header + tabs + thread + composer */}
        <div className="center">
          <TicketHeader ticket={ticket} assigneeName={assigneeName} />
          <TicketTabs
            value={tab}
            onChange={setTab}
            channelName={channelName}
          />
          {tab !== "linked" && (
            <Highlights
              highlights={accountHighlights}
              sourcePath="boolean-knowledge / clients / prorise.md"
              lastEdited="4d ago"
              onSave={handleHighlightsSave}
            />
          )}
          {tab === "internal" ? (
            /* Slice 7: InternalThread wired — dispatch-native, never to Slack (A21) */
            <InternalThread ticketId={ticket.id} />
          ) : (
            <ChatThread
              tab={tab}
              chatItems={chatItems}
              internalItems={internalItems}
            />
          )}
          {tab !== "linked" && tab !== "internal" && (
            <Composer
              ticketId={ticket.id}
              toName="Andre Patel"
              channelName={channelName}
              onSend={handleSend}
              sending={sendReplyMutation.isPending}
            />
          )}
        </div>

        {/* Right: panel + toolbar */}
        <RightPanel
          mode={panel}
          ticket={ticket}
          assigneeName={assigneeName}
          activityItems={activityItems}
        />
        <RToolbar mode={panel} setMode={setPanel} />
      </div>
      {/* Phase 2 / S3 — bottom-slide-up / dock-right terminal panel. Mounts
          when the ticket route is active; unmounts on route leave. */}
      <TerminalPanel ticketId={ticket.displayId} />
    </div>
  );
}
