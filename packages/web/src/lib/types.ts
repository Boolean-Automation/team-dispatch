// dispatch — shared TypeScript types for the web layer
// These types mirror the API response shapes. No business logic here.

export type TicketStatus =
  | "new"
  | "on-you"
  | "waiting-client"
  | "follow-up-required"
  | "follow-up-1-sent"
  | "closeout"
  | "closed"
  | "complete";

export type TicketType = "question" | "reply" | "thanks" | "ooo" | "other";

export type AccountHealth = "good" | "risk" | "crit";

export type SourceKind = "channel" | "dm" | "group-dm" | "email";

export type OriginClass = "client" | "internal" | "unknown";

export type EffortBucket =
  | "client-specific"
  | "platform-shared"
  | "one-time-build"
  | null;

// ── Engineer (Clerk user shape in seed data) ──────────────────────────────────

export interface Engineer {
  key: string;
  name: string;
  initials: string;
  color: string;
  role: "admin" | "se";
}

// ── Account (client) ──────────────────────────────────────────────────────────

export interface Account {
  id: string;
  slug: string;
  displayName: string;
  health: AccountHealth;
  highlights?: string;
  owningSe?: string; // Clerk user id
}

// ── Ticket ────────────────────────────────────────────────────────────────────

export interface Ticket {
  id: string;
  displayId: string; // "DSP-####"
  accountId: string;
  // Denormalized fields for board rendering (from account join)
  clientName: string;
  clientHealth: AccountHealth;
  status: TicketStatus;
  type: TicketType;
  assignee: string | null; // Clerk user id or null (unassigned)
  effortBucket: EffortBucket;
  sourceKind: SourceKind;
  sourceChannelId?: string | null;
  sourceEventTs?: string | null;
  originClass: OriginClass;
  preview: string; // message excerpt, first 160 chars
  ageMin: number; // minutes since opened_at
  slaMin: number | null; // minutes until SLA deadline; null = no SLA; negative = overdue
  paused: boolean; // SLA clock is paused (waiting-client)
  openedAt: string; // ISO datetime
  firstResponseAt?: string;
  resolvedAt?: string;
  slaDeadline?: string;
}

// ── Filters and sort ──────────────────────────────────────────────────────────

export type SortMode = "sla" | "age-desc" | "age-asc" | "client";

export interface BoardFilters {
  client: string; // "all" or account id
  assignee: string; // "all", "unassigned", or Clerk user id
  type: string; // "all" or TicketType
}

// ── Message ───────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  ticketId: string;
  direction: "inbound" | "outbound";
  authorKind: "client" | "se";
  authorRef: string;
  body: string;
  slackTs?: string | null;
  postedAt: string;
  createdAt: string;
}

// ── Activity ──────────────────────────────────────────────────────────────────

export interface ActivityEntry {
  id: string;
  event: string;
  actorId?: string | null;
  ticketId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  undoToken?: string | null;
  createdAt: string;
}

// ── View counts for the rail ──────────────────────────────────────────────────

export interface ViewCounts {
  all: number;
  unassigned: number;
  mine: number;
  accounts: number;
  closed: number;
  shared?: number; // Slice 7: tickets where the user is a reinforcement collaborator (A27)
}

// ── Reinforcement (collaborator join) ─────────────────────────────────────────

export interface ReinforcementInfo {
  ticketId: string;
  collaborator: string;
  addedAt: string;
}

// ── Internal thread message ───────────────────────────────────────────────────

export interface InternalThreadMessageInfo {
  id: string;
  ticketId: string;
  authorId: string;
  body: string;
  postedAt: string;
  createdAt: string;
}
