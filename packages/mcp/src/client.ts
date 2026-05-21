// dispatch MCP — HTTP client
//
// A thin fetch-based client that attaches the machine-credential bearer token
// to every /api/mcp/* call. This module imports NOTHING from @dispatch/core or
// @dispatch/db — the MCP is a pure HTTP client of the dispatch API, not a
// rebuild of the domain logic (structural proof of A2: clean API separation).

export interface DispatchClientConfig {
  /** Base URL of the dispatch API instance, e.g. https://dispatch.paintos.app */
  apiUrl: string;
  /** The machine credential JWT (DISPATCH_API_KEY env var) */
  apiKey: string;
}

export class DispatchClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(config: DispatchClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, ""); // strip trailing slash
    this.apiKey = config.apiKey;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `dispatch API error ${response.status} for ${path}: ${text}`
      );
    }

    return response.json() as Promise<T>;
  }

  async listTickets(query?: Record<string, string>): Promise<unknown[]> {
    const params = query ? "?" + new URLSearchParams(query).toString() : "";
    return this.request<unknown[]>(`/api/mcp/tickets${params}`);
  }

  async getTicket(id: string): Promise<unknown> {
    return this.request<unknown>(`/api/mcp/tickets/${encodeURIComponent(id)}`);
  }

  async listAccounts(): Promise<unknown[]> {
    return this.request<unknown[]>("/api/mcp/accounts");
  }

  async getAccount(id: string): Promise<unknown> {
    return this.request<unknown>(
      `/api/mcp/accounts/${encodeURIComponent(id)}`
    );
  }
}
