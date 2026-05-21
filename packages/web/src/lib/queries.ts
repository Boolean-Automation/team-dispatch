// dispatch — TanStack Query hooks for the API
//
// Slice 3: replaces the seed-data queryFn with live API calls.
// The board query polls every 25s (live-update strategy — plan §Slice 1).
//
// All fetch calls go through the api-client module which attaches the
// Clerk session token header automatically.

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./api-client.js";
import type { Ticket, Account } from "./types.js";

// ── tickets ───────────────────────────────────────────────────────────────────

export interface TicketListParams {
  status?: string;
  assignee?: string;
  accountId?: string;
  type?: string;
  sort?: "sla" | "age-desc" | "age-asc" | "client";
  limit?: number;
  offset?: number;
}

export function useTickets(params: TicketListParams = {}) {
  return useQuery<Ticket[]>({
    queryKey: ["tickets", params],
    queryFn: async () => {
      const searchParams = new URLSearchParams();
      if (params.status) searchParams.set("status", params.status);
      if (params.assignee) searchParams.set("assignee", params.assignee);
      if (params.accountId) searchParams.set("accountId", params.accountId);
      if (params.type) searchParams.set("type", params.type);
      if (params.sort) searchParams.set("sort", params.sort);
      if (params.limit != null)
        searchParams.set("limit", String(params.limit));
      if (params.offset != null)
        searchParams.set("offset", String(params.offset));

      const qs = searchParams.toString();
      return apiClient.get<Ticket[]>(`/api/tickets${qs ? `?${qs}` : ""}`);
    },
    refetchInterval: 25_000,
    staleTime: 20_000,
  });
}

export function useTicket(id: string) {
  return useQuery<Ticket>({
    queryKey: ["ticket", id],
    queryFn: () => apiClient.get<Ticket>(`/api/tickets/${id}`),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

// ── accounts ──────────────────────────────────────────────────────────────────

export function useAccounts() {
  return useQuery<Account[]>({
    queryKey: ["accounts"],
    queryFn: () => apiClient.get<Account[]>("/api/accounts"),
    staleTime: 60_000,
  });
}

export function useAccount(id: string) {
  return useQuery<Account>({
    queryKey: ["account", id],
    queryFn: () => apiClient.get<Account>(`/api/accounts/${id}`),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}
