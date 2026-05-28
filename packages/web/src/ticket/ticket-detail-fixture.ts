// dispatch — ticket-detail fixture data (DEV ONLY)
//
// Used by TicketDetailPage as a fallback when the API is unavailable
// (e.g. local dev without Clerk keys, screenshot builds).
//
// This data is NEVER used in production — the production path always uses the API.
// It is dev-only and clearly marked as such.
//
// Matches the shape of the seed data in ../lib/seed.ts and the JSX source fixture.

import type { Ticket } from "../lib/types";
import type { ThreadItem } from "./Message";
import type { ActivityItem } from "./PanelActivity";

// ── DEV-ONLY fixture ticket ───────────────────────────────────────────────────

export const FIXTURE_TICKET: Ticket = {
  id: "fixture-2876",
  displayId: "DSP-2876",
  accountId: "prorise",
  clientName: "Pro Rise Painting",
  clientHealth: "risk",
  status: "on-you",
  type: "question",
  assignee: "dan",
  effortBucket: null,
  sourceKind: "channel",
  sourceChannelId: "C_PRORISE_SUPPORT",
  originClass: "client",
  preview: "Recurring-revenue automation not firing for new MQLs",
  ageMin: 246,
  slaMin: 78,
  paused: false,
  openedAt: new Date(Date.now() - 246 * 60 * 1000).toISOString(),
};

// ── DEV-ONLY fixture thread ───────────────────────────────────────────────────

export const FIXTURE_CHAT_THREAD: ThreadItem[] = [
  { kind: "day", label: "Tue, May 19" },
  {
    kind: "msg",
    who: "client",
    from: "Andre Patel",
    role: "Pro Rise · Owner",
    time: "2:14 PM",
    src: "#prorise-support",
    text:
      "Hey team — quick one. The recurring-revenue automation isn't firing for new MQLs that come in from Wednesday onwards. Was this a side effect of the property rename on Monday?",
  },
  {
    kind: "msg",
    who: "client",
    from: "Andre Patel",
    role: "Pro Rise · Owner",
    time: "2:15 PM",
    src: "#prorise-support",
    text:
      "Need this fixed before Friday's demo with the new GM. Can someone take a look today?",
  },
  {
    kind: "event",
    text: "Auto-tagged client-health: at-risk · MQL automation is a §9.4 dependency",
    time: "2:15 PM",
  },
  {
    kind: "event",
    text: "Routed to Dan via Trigger \"Route by client owner\"",
    time: "2:16 PM",
  },
  {
    kind: "msg",
    who: "eng",
    from: "Dan Chen",
    role: "you",
    time: "2:38 PM",
    src: "#prorise-support",
    text:
      "On it Andre — pulling up the HubSpot workflow now. The Monday rename touched mql_qualified_at; I'd bet the recurring-revenue automation is still listening to the old internal name. Will have a fix or a clear ETA in the next hour.",
  },
  { kind: "day", label: "Today, Wed May 20" },
  {
    kind: "msg",
    who: "client",
    from: "Andre Patel",
    role: "Pro Rise · Owner",
    time: "9:02 AM",
    src: "#prorise-support",
    text:
      "Morning — any update? The Friday demo is on the calendar with the GM and I want to walk in clean.",
  },
];

export const FIXTURE_INTERNAL_THREAD: ThreadItem[] = [
  {
    kind: "msg",
    who: "eng",
    from: "Dan Chen",
    role: "you",
    time: "Tue 3:01 PM",
    // OQ-3: no channel tag in Phase 1
    text:
      "Confirmed the recurring-revenue automation in HubSpot is still keyed to mql_qualified_at_legacy. We renamed it Monday in the property rename script but the workflow trigger never rebound.",
  },
  {
    kind: "msg",
    who: "eng",
    from: "Celine Romero",
    role: "support",
    time: "Tue 3:14 PM",
    text:
      "Same root cause as Highfill last month — the rename script doesn't reach inside workflow triggers. We should add a Trigger that flags any property rename that touches an active workflow.",
  },
  {
    kind: "msg",
    who: "eng",
    from: "Dan Chen",
    role: "you",
    time: "Tue 3:22 PM",
    text:
      "Yeah +1, I'll write that up after this is closed. For now I'll repoint the trigger and backfill the 6 MQLs that came in since Wed. Will batch the backfill so we don't double-fire.",
  },
];

// ── DEV-ONLY fixture activity ─────────────────────────────────────────────────

export const FIXTURE_ACTIVITY: ActivityItem[] = [
  {
    id: "act-1",
    event: "ticket.created",
    actorId: null,
    after: { source: "prorise-support" },
    createdAt: new Date(Date.now() - 246 * 60 * 1000).toISOString(),
  },
  {
    id: "act-2",
    event: "ticket.assigned",
    actorId: "system",
    after: { assignee: "dan" },
    createdAt: new Date(Date.now() - 244 * 60 * 1000).toISOString(),
  },
  {
    id: "act-3",
    event: "ticket.status_changed",
    actorId: "system",
    before: { status: "new" },
    after: { status: "on-you" },
    createdAt: new Date(Date.now() - 244 * 60 * 1000).toISOString(),
  },
  {
    id: "act-4",
    event: "message.created",
    actorId: "dan",
    after: { direction: "outbound" },
    createdAt: new Date(Date.now() - 228 * 60 * 1000).toISOString(),
  },
];

// ── DEV-ONLY fixture highlights ───────────────────────────────────────────────
// Shape matches the new HighlightsData contract: { content, sourcePath, editedAt } | null

export const FIXTURE_HIGHLIGHTS = {
  content:
    "Pro Rise Painting · 18 mo client · $4.2k MRR, no plan to expand. " +
    "Andre (owner, primary) handles ops; Diego handles finance and only contacts on QBO. " +
    "Lives in HubSpot + PaintScout. Friday-demo cadence with their new GM — " +
    "the recurring-revenue automation is the load-bearing metric in that demo. " +
    "Past blockers: dependent-property mapping (Mar), invoice double-fire (Jan).",
  sourcePath: "clients/prorise/profile.md",
  editedAt: "4d ago",
};
