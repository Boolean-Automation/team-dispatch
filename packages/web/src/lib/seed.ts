// dispatch — seed data for Slice 1
// Shaped like the future GET /api/tickets + GET /api/accounts responses.
// Slice 3 replaces board reads with live API queries; this becomes a test/dev fixture.
//
// Live-update strategy (per plan §Slice 1):
//   TanStack Query uses a refetchInterval of ~25s on board queries.
//   Slice 1 polls against this seed array (identical shape to the API response).
//   Slice 3 swaps the queryFn to fetch from GET /api/tickets — no other change.

import type { Account, Engineer, Ticket } from "./types";

// ── Engineers ─────────────────────────────────────────────────────────────────

export const ENGINEERS: Record<string, Engineer> = {
  dan: { key: "dan", name: "Dan", initials: "DC", color: "#34D399", role: "se" },
  celine: {
    key: "celine",
    name: "Celine",
    initials: "CR",
    color: "#FBBF24",
    role: "se",
  },
  marcel: {
    key: "marcel",
    name: "Marcel",
    initials: "MA",
    color: "#60A5FA",
    role: "se",
  },
  eveguel: {
    key: "eveguel",
    name: "Eveguel",
    initials: "EV",
    color: "#C084FC",
    role: "se",
  },
  rensy: {
    key: "rensy",
    name: "Rensy",
    initials: "RS",
    color: "#F472B6",
    role: "se",
  },
  justin: {
    key: "justin",
    name: "Justin",
    initials: "JR",
    color: "#22D3EE",
    role: "se",
  },
};

export const SIGNED_IN_KEY = "dan";

// ── Accounts ──────────────────────────────────────────────────────────────────

export const ACCOUNTS: Record<string, Account> = {
  highfill: {
    id: "highfill",
    slug: "highfill",
    displayName: "Highfill Painting",
    health: "good",
  },
  "519": {
    id: "519",
    slug: "519",
    displayName: "519 Painters",
    health: "risk",
  },
  funky: {
    id: "funky",
    slug: "funky",
    displayName: "Funky Painting",
    health: "good",
  },
  paragon: {
    id: "paragon",
    slug: "paragon",
    displayName: "Paragon Painting",
    health: "good",
  },
  heiler: {
    id: "heiler",
    slug: "heiler",
    displayName: "Heiler Painting",
    health: "good",
  },
  prorise: {
    id: "prorise",
    slug: "prorise",
    displayName: "Pro Rise Painting",
    health: "risk",
  },
  mclains: {
    id: "mclains",
    slug: "mclains",
    displayName: "McLains Painting",
    health: "crit",
  },
  blair: {
    id: "blair",
    slug: "blair",
    displayName: "Blair Commercial",
    health: "risk",
  },
};

export const HEALTH_LABEL: Record<string, string> = {
  good: "Good standing",
  risk: "At risk",
  crit: "Critical",
};

// ── Default view counts for the rail ─────────────────────────────────────────

export const DEFAULT_VIEW_COUNTS = {
  all: 16,
  unassigned: 3,
  mine: 4,
  accounts: 28,
  closed: 412,
};

// ── Tickets ───────────────────────────────────────────────────────────────────

export const SEED_TICKETS: Ticket[] = [
  // ── NEW (3) ────────────────────────────────────────────────────────────────
  {
    id: "seed-2891",
    displayId: "DSP-2891",
    accountId: "highfill",
    clientName: "Highfill Painting",
    clientHealth: "good",
    status: "new",
    type: "question",
    assignee: null,
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Mike: HubSpot deal moved to Lost but PaintScout still showing as active — can someone check?",
    ageMin: 12,
    slaMin: 348,
    paused: false,
    openedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2890",
    displayId: "DSP-2890",
    accountId: "heiler",
    clientName: "Heiler Painting",
    clientHealth: "good",
    status: "new",
    type: "reply",
    assignee: null,
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Ben Heiler: thanks for the migration timeline — one follow-up on the Prismatic workflow",
    ageMin: 38,
    slaMin: 322,
    paused: false,
    openedAt: new Date(Date.now() - 38 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2889",
    displayId: "DSP-2889",
    accountId: "519",
    clientName: "519 Painters",
    clientHealth: "risk",
    status: "new",
    type: "question",
    assignee: null,
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Trevor: where do I find the new contractor schedule view? Don't see it on my dashboard.",
    ageMin: 64,
    slaMin: 296,
    paused: false,
    openedAt: new Date(Date.now() - 64 * 60 * 1000).toISOString(),
  },

  // ── ON YOU (4) ─────────────────────────────────────────────────────────────
  {
    id: "seed-2884",
    displayId: "DSP-2884",
    accountId: "paragon",
    clientName: "Paragon Painting",
    clientHealth: "good",
    status: "on-you",
    type: "question",
    assignee: "dan",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Seth: pulling commission reports for Q2 — numbers look off vs QBO. Sending screenshots.",
    ageMin: 142,
    slaMin: 231,
    paused: false,
    openedAt: new Date(Date.now() - 142 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2879",
    displayId: "DSP-2879",
    accountId: "funky",
    clientName: "Funky Painting",
    clientHealth: "good",
    status: "on-you",
    type: "reply",
    assignee: "celine",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Mark: tested the invoice double-deduct fix, looking good. One more edge case I want to confirm.",
    ageMin: 198,
    slaMin: 164,
    paused: false,
    openedAt: new Date(Date.now() - 198 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2876",
    displayId: "DSP-2876",
    accountId: "prorise",
    clientName: "Pro Rise Painting",
    clientHealth: "risk",
    status: "on-you",
    type: "question",
    assignee: "dan",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Andre: recurring revenue automation isn't firing for new MQLs. Need this before Friday demo.",
    ageMin: 246,
    slaMin: 78,
    paused: false,
    openedAt: new Date(Date.now() - 246 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2875",
    displayId: "DSP-2875",
    accountId: "mclains",
    clientName: "McLains Painting",
    clientHealth: "crit",
    status: "on-you",
    type: "ooo",
    assignee: "marcel",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Auto-reply detected from primary contact — Sarah on PTO through Mon. Coverage assigned to ops.",
    ageMin: 312,
    slaMin: -42,
    paused: false,
    openedAt: new Date(Date.now() - 312 * 60 * 1000).toISOString(),
  },

  // ── WAITING ON CLIENT (3) ──────────────────────────────────────────────────
  {
    id: "seed-2870",
    displayId: "DSP-2870",
    accountId: "highfill",
    clientName: "Highfill Painting",
    clientHealth: "good",
    status: "waiting-client",
    type: "reply",
    assignee: "celine",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Sent updated dependent-property mapping. Awaiting confirmation from Mike on field overrides.",
    ageMin: 1620,
    slaMin: null,
    paused: true,
    openedAt: new Date(Date.now() - 1620 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2862",
    displayId: "DSP-2862",
    accountId: "blair",
    clientName: "Blair Commercial",
    clientHealth: "risk",
    status: "waiting-client",
    type: "question",
    assignee: "marcel",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Asked Bill for the QBO API key + sandbox creds — no response since Monday afternoon.",
    ageMin: 3360,
    slaMin: null,
    paused: true,
    openedAt: new Date(Date.now() - 3360 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2858",
    displayId: "DSP-2858",
    accountId: "519",
    clientName: "519 Painters",
    clientHealth: "risk",
    status: "waiting-client",
    type: "other",
    assignee: "celine",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Scope clarification sent for contractor schedule build. Awaiting decision on Schedule v2 vs v1.",
    ageMin: 4500,
    slaMin: null,
    paused: true,
    openedAt: new Date(Date.now() - 4500 * 60 * 1000).toISOString(),
  },

  // ── FOLLOW-UP REQUIRED (2) ─────────────────────────────────────────────────
  {
    id: "seed-2841",
    displayId: "DSP-2841",
    accountId: "funky",
    clientName: "Funky Painting",
    clientHealth: "good",
    status: "follow-up-required",
    type: "thanks",
    assignee: "eveguel",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      'Anna: "all set — workflow is firing correctly now, thanks!" Schedule 7-day check-in.',
    ageMin: 9120,
    slaMin: null,
    paused: false,
    openedAt: new Date(Date.now() - 9120 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2839",
    displayId: "DSP-2839",
    accountId: "paragon",
    clientName: "Paragon Painting",
    clientHealth: "good",
    status: "follow-up-required",
    type: "other",
    assignee: "dan",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "YCBM autofill link deployed. Confirm with Seth that it's pulling correct UTMs end-to-end.",
    ageMin: 10140,
    slaMin: null,
    paused: false,
    openedAt: new Date(Date.now() - 10140 * 60 * 1000).toISOString(),
  },

  // ── FOLLOW-UP 1 SENT (2) ───────────────────────────────────────────────────
  {
    id: "seed-2820",
    displayId: "DSP-2820",
    accountId: "mclains",
    clientName: "McLains Painting",
    clientHealth: "crit",
    status: "follow-up-1-sent",
    type: "question",
    assignee: "marcel",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "First check-in sent — no reply. Asked about MQL→SQL flow performance over the last 2 weeks.",
    ageMin: 13320,
    slaMin: null,
    paused: false,
    openedAt: new Date(Date.now() - 13320 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2815",
    displayId: "DSP-2815",
    accountId: "519",
    clientName: "519 Painters",
    clientHealth: "risk",
    status: "follow-up-1-sent",
    type: "reply",
    assignee: "celine",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "First check-in sent. Awaiting decision on contractor Schedule v2 — pinged Trevor + Diego.",
    ageMin: 15840,
    slaMin: null,
    paused: false,
    openedAt: new Date(Date.now() - 15840 * 60 * 1000).toISOString(),
  },

  // ── CLOSEOUT (2) ───────────────────────────────────────────────────────────
  {
    id: "seed-2798",
    displayId: "DSP-2798",
    accountId: "funky",
    clientName: "Funky Painting",
    clientHealth: "good",
    status: "closeout",
    type: "thanks",
    assignee: "celine",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Mark confirmed invoice fix is solid. Ready to close — final sign-off + handoff doc needed.",
    ageMin: 20160,
    slaMin: null,
    paused: false,
    openedAt: new Date(Date.now() - 20160 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-2795",
    displayId: "DSP-2795",
    accountId: "heiler",
    clientName: "Heiler Painting",
    clientHealth: "good",
    status: "closeout",
    type: "other",
    assignee: "dan",
    effortBucket: null,
    sourceKind: "channel",
    originClass: "client",
    preview:
      "Migration sprint complete, ticket eligible for closeout. Schedule retro + final sign-off.",
    ageMin: 23040,
    slaMin: null,
    paused: false,
    openedAt: new Date(Date.now() - 23040 * 60 * 1000).toISOString(),
  },
];
