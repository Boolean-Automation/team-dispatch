// dispatch — Board component (kanban layout)
// Renders six status columns. In Slice 1 data comes from seed; Slice 3 swaps
// to the live API query with identical refetchInterval polling.

import React, { useMemo } from "react";
import { Column } from "./Column";
import { slaSortKey } from "../shell/format";
import type { Ticket, BoardFilters, SortMode } from "../lib/types";
import { ACCOUNTS } from "../lib/seed";

export const STATUSES = [
  { key: "new", name: "New" },
  { key: "on-you", name: "On You" },
  { key: "waiting-client", name: "Waiting on Client" },
  { key: "follow-up-required", name: "Follow-up Required" },
  { key: "follow-up-1-sent", name: "Follow-up 1 Sent" },
  { key: "closeout", name: "Closeout Follow-up Required" },
  // Closed lives on the board so closed tickets are findable and can be
  // reopened inline (Card renders a Reopen action for status === "closed").
  { key: "closed", name: "Closed" },
] as const;

interface BoardProps {
  tickets: Ticket[];
  filters: BoardFilters;
  sort: SortMode;
  focusedId: string | null;
  onFocus: (id: string) => void;
}

export function Board({ tickets, filters, sort, focusedId, onFocus }: BoardProps) {
  const filtered = useMemo(() => {
    return tickets.filter((x) => {
      if (filters.client !== "all" && x.accountId !== filters.client) return false;
      if (filters.type !== "all" && x.type !== filters.type) return false;
      if (filters.assignee !== "all") {
        if (filters.assignee === "unassigned") {
          if (x.assignee) return false;
        } else if (x.assignee !== filters.assignee) {
          return false;
        }
      }
      return true;
    });
  }, [tickets, filters]);

  const sorted = useMemo(() => {
    const cmps: Record<SortMode, (a: Ticket, b: Ticket) => number> = {
      sla: (a, b) => slaSortKey(a) - slaSortKey(b),
      "age-desc": (a, b) => b.ageMin - a.ageMin,
      "age-asc": (a, b) => a.ageMin - b.ageMin,
      client: (a, b) => a.clientName.localeCompare(b.clientName),
    };
    return [...filtered].sort(cmps[sort]);
  }, [filtered, sort]);

  const byStatus = useMemo(() => {
    const m: Record<string, Ticket[]> = {};
    STATUSES.forEach((s) => (m[s.key] = []));
    sorted.forEach((x) => {
      if (m[x.status]) m[x.status]!.push(x);
    });
    return m;
  }, [sorted]);

  return (
    <div className="board-wrap">
      <div className="board">
        {STATUSES.map((s) => (
          <Column
            key={s.key}
            status={s}
            tickets={byStatus[s.key] ?? []}
            focusedId={focusedId}
            onFocus={onFocus}
          />
        ))}
      </div>
    </div>
  );
}
