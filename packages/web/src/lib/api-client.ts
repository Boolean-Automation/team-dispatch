// dispatch — HTTP API client for the web layer
//
// All API calls go through this module — never a bare `fetch` in a component.
// TanStack Query hooks (queries.ts, Slice 3) use this client.
//
// Slice 2: wires the Clerk session token onto every request.
// Slice 3: adds typed methods for /api/tickets, /api/accounts, etc.

import type { TokenProvider } from "./auth.js";

// Base URL — empty string means "same origin" (works for local dev + Railway)
const API_BASE = "";

export type ApiRole = "admin" | "se";

export interface MeResponse {
  userId: string;
  role: ApiRole;
}

// ── Internal fetch wrapper ─────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  getToken?: TokenProvider
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  if (getToken) {
    const token = await getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let message = `API error ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      message = body.message ?? message;
    } catch {
      // ignore JSON parse failure
    }
    const err = new Error(message) as Error & { statusCode: number };
    err.statusCode = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

// ── API client factory ─────────────────────────────────────────────────────────
//
// Usage:
//   const client = createApiClient(() => getToken());
//   const me = await client.getMe();

export function createApiClient(getToken?: TokenProvider) {
  return {
    /** GET /api/me — returns the authenticated SE's identity */
    getMe(): Promise<MeResponse> {
      return apiFetch<MeResponse>("/api/me", {}, getToken);
    },

    /** GET /api/health — liveness check */
    getHealth(): Promise<{ ok: boolean }> {
      return apiFetch<{ ok: boolean }>("/api/health");
    },
  };
}

// Singleton client for use in hooks that provide their own token getter.
// Slice 3 will extend this with ticket / account methods.
export type ApiClient = ReturnType<typeof createApiClient>;
