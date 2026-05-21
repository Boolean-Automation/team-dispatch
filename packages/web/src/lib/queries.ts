// dispatch — TanStack Query hooks for the API
//
// Slice 3: replaces the seed-data queryFn with live API calls.
// The board query polls every 25s (live-update strategy — plan §Slice 1).
//
// All fetch calls go through the api-client module which attaches the
// Clerk session token header automatically.

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./api-client.js";
import type { Ticket, Account, Message, ActivityEntry } from "./types.js";

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
    // Don't retry on client errors (4xx) — fail fast for fixture fallback in dev
    retry: (failureCount, error) => {
      const statusCode = (error as Error & { statusCode?: number })?.statusCode;
      if (statusCode && statusCode >= 400 && statusCode < 500) return false;
      return failureCount < 1; // max 1 retry on other errors
    },
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

// ── messages ──────────────────────────────────────────────────────────────────

export function useMessages(ticketId: string) {
  return useQuery<Message[]>({
    queryKey: ["messages", ticketId],
    queryFn: () =>
      apiClient.get<Message[]>(`/api/tickets/${ticketId}/messages`),
    enabled: Boolean(ticketId),
    refetchInterval: 25_000,
    staleTime: 10_000,
  });
}

// ── activity ──────────────────────────────────────────────────────────────────

export function useTicketActivity(ticketId: string) {
  return useQuery<ActivityEntry[]>({
    queryKey: ["activity", ticketId],
    queryFn: () =>
      apiClient.get<ActivityEntry[]>(`/api/tickets/${ticketId}/activity`),
    enabled: Boolean(ticketId),
    staleTime: 15_000,
  });
}
