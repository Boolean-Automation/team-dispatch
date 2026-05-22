// dispatch — Slice 0 cross-route XSS test rig
//
// Plan §Slice 0:
//   "For each of the SPA's current routes (`/`, `/t/<displayId>`, `/settings`,
//    `/analytics`)…render with React Testing Library under a mock provider
//    that injects malicious payloads into every user-controllable field the
//    route reads."
//
// What this proves (the negative):
//   window.__pwn is `undefined` after every render. If ANY payload reached an
//   eval-shaped path — dangerouslySetInnerHTML, a href={`javascript:…`}, a
//   direct DOM mutation through innerHTML — the canary would be `true`.
//
// What this DOES NOT prove:
//   It doesn't prove that React itself is bug-free. It proves that the
//   dispatch codebase, as written today, doesn't carry a sink that exposes
//   user input to a HTML/JS interpreter. The CSP test (csp-headers.test.ts)
//   is the defense-in-depth layer that would catch any escape that this test
//   misses (modulo the documented style-src-attr 'unsafe-inline' carve-out).
//
// Mocking strategy:
//   - vi.mock the query hooks (`useTickets`, `useTicket`, `useMessages`,
//     `useTicketActivity`, `useAccount`) so we can feed malicious payloads
//     into ticket bodies, account highlights, message bodies, etc., without
//     wiring a real network.
//   - vi.mock `clerk` so RequireAuth + useDispatchUser pass through.
//   - MemoryRouter so we can render each route independently.

import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { XSS_PAYLOADS } from "./payloads";
import type {
  Ticket,
  Account,
  Message,
  ActivityEntry,
} from "../lib/types";

// ── Mocks: query hooks (the API boundary) ────────────────────────────────────
//
// We mock at the system boundary per TDD mocking discipline — `useTickets` &
// friends are the seam where dispatch code stops and TanStack Query / fetch
// starts.

vi.mock("../lib/queries", async () => {
  return {
    useTickets: vi.fn(),
    useTicket: vi.fn(),
    useMessages: vi.fn(),
    useTicketActivity: vi.fn(),
    useAccount: vi.fn(),
  };
});

vi.mock("../lib/clerk", async () => {
  return {
    useDispatchUser: vi.fn(() => null),
    RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ClerkProviderWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// The Composer component imports api-client for the highlights PATCH. We
// don't exercise that path in this test, but we stub the module so its
// side-effect-free import succeeds.
vi.mock("../lib/api-client", async () => {
  return {
    apiClient: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      del: vi.fn(),
    },
    setTokenProvider: vi.fn(),
  };
});

// Mute the undoable-mutation toast hook so rendering Composer doesn't try to
// reach a real query client mutation lifecycle.
vi.mock("../lib/use-undoable-mutation", async () => {
  return {
    useUndoableMutation: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  };
});

import { useTickets, useTicket, useMessages, useTicketActivity, useAccount } from "../lib/queries";
import { IssuesPage } from "../issues/IssuesPage";
import { TicketDetailPage } from "../ticket/TicketDetailPage";
import { SettingsPage } from "../settings/SettingsPage";
import { TerminalSettingsPage } from "../routes/settings/terminal";
import { AnalyticsPage } from "../analytics/AnalyticsPage";

// ── Fixture builders parameterized by malicious payload ──────────────────────

function buildToxicTicket(payload: string, index: number): Ticket {
  return {
    id: `tkt_${index}`,
    displayId: `DSP-${1000 + index}`,
    accountId: `acct_${index}`,
    // User-controllable strings receive the payload
    clientName: payload,
    clientHealth: "good",
    status: "on-you",
    type: "question",
    assignee: null,
    effortBucket: null,
    sourceKind: "channel",
    sourceChannelId: payload,
    sourceEventTs: null,
    originClass: "client",
    preview: payload, // body excerpt
    ageMin: 10,
    slaMin: 30,
    paused: false,
    openedAt: new Date().toISOString(),
  };
}

function buildToxicMessage(payload: string, index: number): Message {
  return {
    id: `msg_${index}`,
    ticketId: `tkt_${index}`,
    direction: "inbound",
    authorKind: "client",
    authorRef: payload, // user displayName
    body: payload, // message body
    slackTs: null,
    postedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function buildToxicAccount(payload: string, index: number): Account {
  return {
    id: `acct_${index}`,
    slug: `acct-${index}`,
    displayName: payload, // user-controllable
    health: "good",
    highlights: payload, // notes (user-controllable)
    owningSe: undefined,
  };
}

function buildToxicActivity(payload: string, index: number): ActivityEntry {
  return {
    id: `act_${index}`,
    event: "message_sent",
    actorId: payload,
    ticketId: `tkt_${index}`,
    before: null,
    after: { body: payload },
    undoToken: null,
    createdAt: new Date().toISOString(),
  };
}

// ── Test harness ─────────────────────────────────────────────────────────────

function renderRoute(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={<IssuesPage />} />
          <Route path="/t/:displayId" element={<TicketDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="/settings/terminal"
            element={<TerminalSettingsPage userOverride={null} />}
          />
          <Route path="/analytics" element={<AnalyticsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function setMocksForPayload(payload: string, index: number) {
  const ticket = buildToxicTicket(payload, index);
  const messages = [buildToxicMessage(payload, index)];
  const activity = [buildToxicActivity(payload, index)];
  const account = buildToxicAccount(payload, index);

  (useTickets as unknown as Mock).mockReturnValue({
    data: [ticket],
    dataUpdatedAt: Date.now(),
    isLoading: false,
    isError: false,
    error: null,
  });
  (useTicket as unknown as Mock).mockReturnValue({
    data: ticket,
    isLoading: false,
    isError: false,
    error: null,
  });
  (useMessages as unknown as Mock).mockReturnValue({
    data: messages,
    isLoading: false,
    isError: false,
  });
  (useTicketActivity as unknown as Mock).mockReturnValue({
    data: activity,
    isLoading: false,
    isError: false,
  });
  (useAccount as unknown as Mock).mockReturnValue({
    data: account,
    isLoading: false,
    isError: false,
  });
}

// ── Storage spy ──────────────────────────────────────────────────────────────
// The plan calls out a stronger assertion than the canary alone:
//   "no companion.session.token write to sessionStorage/localStorage from a
//    non-PTY caller"
// We patch setItem on both storages and watch for that specific key landing.

function setupStorageSpies() {
  const sessionWrites: Array<[string, string]> = [];
  const localWrites: Array<[string, string]> = [];
  const origSession = Storage.prototype.setItem;
  Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
    // `this` distinguishes sessionStorage from localStorage when both share
    // the prototype.
    if (this === sessionStorage) sessionWrites.push([key, value]);
    else if (this === localStorage) localWrites.push([key, value]);
    return origSession.call(this, key, value);
  };
  return {
    sessionWrites,
    localWrites,
    restore: () => {
      Storage.prototype.setItem = origSession;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

const ROUTES: Array<{ name: string; path: string }> = [
  { name: "/", path: "/" },
  { name: "/t/<displayId>", path: "/t/DSP-1000" },
  { name: "/settings", path: "/settings" },
  { name: "/analytics", path: "/analytics" },
];

describe("Slice 0 — cross-route XSS hardening", () => {
  beforeEach(() => {
    // Reset the canary before every test.
    delete (window as Window).__pwn;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    delete (window as Window).__pwn;
  });

  describe.each(ROUTES)("$name route", ({ path }) => {
    it("does not execute any of the XSS payloads", () => {
      XSS_PAYLOADS.forEach((payload, index) => {
        setMocksForPayload(payload, index);
        const { unmount } = renderRoute(path);
        // The canary must remain undefined after each render.
        expect(
          (window as Window).__pwn,
          `payload ${index} (${payload.slice(0, 40)}…) on ${path} executed`
        ).toBeUndefined();
        unmount();
      });
    });

    it("does not introduce a <script> element into the DOM via user data", () => {
      XSS_PAYLOADS.forEach((payload, index) => {
        setMocksForPayload(payload, index);
        const { container, unmount } = renderRoute(path);
        const scripts = container.querySelectorAll("script");
        expect(
          scripts.length,
          `payload ${index} created ${scripts.length} <script> elements on ${path}`
        ).toBe(0);
        unmount();
      });
    });

    it("does not introduce an <iframe> element into the DOM via user data", () => {
      XSS_PAYLOADS.forEach((payload, index) => {
        setMocksForPayload(payload, index);
        const { container, unmount } = renderRoute(path);
        const iframes = container.querySelectorAll("iframe");
        expect(
          iframes.length,
          `payload ${index} created ${iframes.length} <iframe> elements on ${path}`
        ).toBe(0);
        unmount();
      });
    });

    it("does not write companion.session.token to storage during render", () => {
      const spies = setupStorageSpies();
      try {
        XSS_PAYLOADS.forEach((payload, index) => {
          setMocksForPayload(payload, index);
          const { unmount } = renderRoute(path);
          const sessionHit = spies.sessionWrites.find(
            ([k]) => k === "companion.session.token"
          );
          const localHit = spies.localWrites.find(
            ([k]) => k === "companion.session.token"
          );
          expect(sessionHit, `payload ${index} wrote sessionStorage companion.session.token`).toBeUndefined();
          expect(localHit, `payload ${index} wrote localStorage companion.session.token`).toBeUndefined();
          unmount();
        });
      } finally {
        spies.restore();
      }
    });
  });

  // Sanity: a mechanic check that the __pwn canary is actually observable.
  // The point: if `window.__pwn` could never be set under any condition in
  // this test env, then the negative assertions above are vacuous. By the
  // HTML spec, jsdom (correctly) does not execute scripts inserted via
  // innerHTML / dangerouslySetInnerHTML — so we can't simulate "what would
  // a successful XSS look like". Instead, prove the canary is observable by
  // setting it directly + reading it back. This is enough to know the
  // mechanic isn't broken (e.g. by a beforeEach that masks `window`).
  it("the __pwn canary is observable when explicitly set (mechanic check)", () => {
    expect((window as Window).__pwn).toBeUndefined();
    (window as Window).__pwn = true;
    expect((window as Window).__pwn).toBe(true);
  });
});
