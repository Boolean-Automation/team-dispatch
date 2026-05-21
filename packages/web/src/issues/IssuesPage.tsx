// dispatch — IssuesPage (the main kanban board route: /)
// Slice 1: reads from seed data via a TanStack Query query with refetchInterval.
// Slice 3: swaps queryFn to GET /api/tickets — no other change needed.
//
// Live-update strategy (plan §Slice 1):
//   refetchInterval: 25_000 (25s) — adequate for 2-person pilot, no websockets.
//   The status-bar lastSync label is wired to dataUpdatedAt (the real fetch time).

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Rail } from "../shell/Rail";
import { Topbar } from "../shell/Topbar";
import { StatusBar } from "../shell/StatusBar";
import { Board, STATUSES } from "./Board";
import { SEED_TICKETS, SIGNED_IN_KEY } from "../lib/seed";
import type { BoardFilters, SortMode, Ticket } from "../lib/types";

// Slice 1 query function — returns seed data immediately.
// Slice 3 replaces this with: fetch("/api/tickets").then(r => r.json())
async function fetchTickets(): Promise<Ticket[]> {
  return SEED_TICKETS;
}

export function IssuesPage() {
  const [filters, setFilters] = useState<BoardFilters>({
    client: "all",
    assignee: "all",
    type: "all",
  });
  const [sort, setSort] = useState<SortMode>("sla");
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // TanStack Query — polls every 25s. dataUpdatedAt drives the status bar.
  const { data: tickets = [], dataUpdatedAt } = useQuery<Ticket[]>({
    queryKey: ["tickets"],
    queryFn: fetchTickets,
    refetchInterval: 25_000,
    staleTime: 20_000,
  });

  // Compute view counts for the rail
  const onYouCount = tickets.filter((t) => t.assignee === SIGNED_IN_KEY).length;
  const unassignedCount = tickets.filter((t) => !t.assignee).length;
  const viewCounts = {
    all: tickets.length,
    unassigned: unassignedCount,
    mine: onYouCount,
    accounts: 28,
    closed: 412,
  };

  // "On you" count for the status bar (after any board filter)
  const onYouInView = tickets.filter(
    (t) => t.status === "on-you" && t.assignee === SIGNED_IN_KEY
  ).length;

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
          tickets={tickets}
          filters={filters}
          sort={sort}
          focusedId={focusedId}
          onFocus={setFocusedId}
        />
        <StatusBar
          totalCount={tickets.length}
          onYouCount={onYouInView}
          unassignedCount={unassignedCount}
          dataUpdatedAt={dataUpdatedAt}
        />
      </div>
    </div>
  );
}
