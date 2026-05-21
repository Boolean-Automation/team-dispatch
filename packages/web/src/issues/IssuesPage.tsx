// dispatch — IssuesPage (the main kanban board route: /)
//
// Slice 3: reads from the live GET /api/tickets via TanStack Query.
//   - queryFn replaced with fetch("/api/tickets") — no other structural change.
//   - refetchInterval: 25_000 (25s live-update polling, plan §Slice 1).
//   - dataUpdatedAt from TanStack Query drives the status-bar "last sync" label.
//
// The seed.ts array is now a test/dev fixture only (not imported here).

import React, { useState } from "react";
import { Rail } from "../shell/Rail";
import { Topbar } from "../shell/Topbar";
import { StatusBar } from "../shell/StatusBar";
import { Board } from "./Board";
import { useTickets } from "../lib/queries";
import { useDispatchUser } from "../lib/clerk";
import type { BoardFilters, SortMode } from "../lib/types";

export function IssuesPage() {
  const [filters, setFilters] = useState<BoardFilters>({
    client: "all",
    assignee: "all",
    type: "all",
  });
  const [sort, setSort] = useState<SortMode>("sla");
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const dispatchUser = useDispatchUser();

  // Build API query params from filter state
  const queryParams = {
    ...(filters.assignee !== "all"
      ? { assignee: filters.assignee }
      : {}),
    ...(filters.type !== "all" ? { type: filters.type } : {}),
    sort,
  };

  // TanStack Query — polls every 25s. dataUpdatedAt drives the status bar.
  const { data: tickets = [], dataUpdatedAt } = useTickets(queryParams);

  // Client-side filter by account (accountId from "client" filter)
  const visibleTickets =
    filters.client === "all"
      ? tickets
      : tickets.filter((t) => t.accountId === filters.client);

  // Compute view counts for the rail
  const myUserId = dispatchUser?.userId;
  const onYouCount = myUserId
    ? visibleTickets.filter((t) => t.assignee === myUserId).length
    : 0;
  const unassignedCount = visibleTickets.filter((t) => !t.assignee).length;

  const viewCounts = {
    all: tickets.length,
    unassigned: unassignedCount,
    mine: onYouCount,
    accounts: 0, // populated by Slice 4+ with real account data
    closed: 0,
  };

  // "On you" tickets in view (for status bar)
  const onYouInView = myUserId
    ? visibleTickets.filter(
        (t) => t.status === "on-you" && t.assignee === myUserId
      ).length
    : 0;

  return (
    <div className="app">
      <Rail current="issues" viewCounts={viewCounts} />
      <div className="main">
        <Topbar
          filters={filters}
          setFilters={setFilters}
          sort={sort}
          setSort={setSort}
          viewLabel="All issues"
        />
        <Board
          tickets={visibleTickets}
          filters={filters}
          sort={sort}
          focusedId={focusedId}
          onFocus={setFocusedId}
        />
        <StatusBar
          totalCount={visibleTickets.length}
          onYouCount={onYouInView}
          unassignedCount={unassignedCount}
          dataUpdatedAt={dataUpdatedAt}
        />
      </div>
    </div>
  );
}
