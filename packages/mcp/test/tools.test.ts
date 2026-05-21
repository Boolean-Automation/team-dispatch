// dispatch MCP — tool-level tests
//
// Tests each MCP tool by mocking the HTTP fetch — no live server needed.
// Verifies that each tool:
//   1. Calls the correct URL + headers
//   2. Parses the response correctly
//   3. Handles errors from the API
//
// The DispatchClient is instantiated with a test URL and API key.
// Global fetch is replaced with a vi.fn() mock.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DispatchClient } from "../src/client.js";

const TEST_API_URL = "https://dispatch.test.internal";
const TEST_API_KEY = "eyJtest.machine.token";

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mockFn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", mockFn);
  return mockFn;
}

function capturedUrl(mockFn: ReturnType<typeof vi.fn>): string {
  return mockFn.mock.calls[0]?.[0] as string;
}

function capturedHeaders(
  mockFn: ReturnType<typeof vi.fn>
): Record<string, string> {
  return (mockFn.mock.calls[0]?.[1] as { headers: Record<string, string> })
    .headers;
}

// ── DispatchClient tests ──────────────────────────────────────────────────────

describe("DispatchClient", () => {
  let client: DispatchClient;

  beforeEach(() => {
    client = new DispatchClient({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── listTickets ─────────────────────────────────────────────────────────────

  it("listTickets: calls correct URL with Bearer auth", async () => {
    const mockFn = mockFetch([]);

    await client.listTickets();

    expect(capturedUrl(mockFn)).toBe(`${TEST_API_URL}/api/mcp/tickets`);
    expect(capturedHeaders(mockFn).Authorization).toBe(
      `Bearer ${TEST_API_KEY}`
    );
  });

  it("listTickets: appends query params when provided", async () => {
    mockFetch([]);

    await client.listTickets({ status: "open", accountId: "acct-123" });

    // Fetch was called with the right first argument
    const globalFetch = vi.mocked(fetch);
    const calledUrl = globalFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("status=open");
    expect(calledUrl).toContain("accountId=acct-123");
  });

  it("listTickets: returns parsed JSON array", async () => {
    const tickets = [{ id: "abc", displayId: "DSP-2901" }];
    mockFetch(tickets);

    const result = await client.listTickets();

    expect(result).toEqual(tickets);
  });

  // ── getTicket ───────────────────────────────────────────────────────────────

  it("getTicket: calls correct URL for UUID", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const mockFn = mockFetch({ id });

    await client.getTicket(id);

    expect(capturedUrl(mockFn)).toBe(
      `${TEST_API_URL}/api/mcp/tickets/${encodeURIComponent(id)}`
    );
  });

  it("getTicket: calls correct URL for DSP- display id", async () => {
    const mockFn = mockFetch({ displayId: "DSP-2901" });

    await client.getTicket("DSP-2901");

    expect(capturedUrl(mockFn)).toBe(
      `${TEST_API_URL}/api/mcp/tickets/DSP-2901`
    );
  });

  it("getTicket: returns parsed JSON object", async () => {
    const ticket = { id: "abc", displayId: "DSP-2901", status: "open" };
    mockFetch(ticket);

    const result = await client.getTicket("DSP-2901");

    expect(result).toEqual(ticket);
  });

  // ── listAccounts ────────────────────────────────────────────────────────────

  it("listAccounts: calls correct URL with Bearer auth", async () => {
    const mockFn = mockFetch([]);

    await client.listAccounts();

    expect(capturedUrl(mockFn)).toBe(`${TEST_API_URL}/api/mcp/accounts`);
    expect(capturedHeaders(mockFn).Authorization).toBe(
      `Bearer ${TEST_API_KEY}`
    );
  });

  it("listAccounts: returns parsed JSON array", async () => {
    const accounts = [{ id: "acct-1", name: "Paint Denver" }];
    mockFetch(accounts);

    const result = await client.listAccounts();

    expect(result).toEqual(accounts);
  });

  // ── getAccount ──────────────────────────────────────────────────────────────

  it("getAccount: calls correct URL for UUID", async () => {
    const id = "acct-00000000-1111";
    const mockFn = mockFetch({ id });

    await client.getAccount(id);

    expect(capturedUrl(mockFn)).toBe(
      `${TEST_API_URL}/api/mcp/accounts/${encodeURIComponent(id)}`
    );
  });

  it("getAccount: returns parsed JSON object", async () => {
    const account = { id: "acct-1", name: "Paint Denver" };
    mockFetch(account);

    const result = await client.getAccount("acct-1");

    expect(result).toEqual(account);
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("throws on non-OK response", async () => {
    mockFetch({ error: "Not Found" }, 404);

    await expect(client.getTicket("DSP-9999")).rejects.toThrow(
      "dispatch API error 404"
    );
  });

  it("throws on 401 from API", async () => {
    mockFetch({ error: "Unauthorized", statusCode: 401 }, 401);

    await expect(client.listTickets()).rejects.toThrow(
      "dispatch API error 401"
    );
  });

  // ── Structural proof: no @dispatch/core or @dispatch/db imports ─────────────
  // (enforced by package.json not listing them as dependencies — this test
  //  simply confirms the client module can be imported without them)
  it("imports cleanly without @dispatch/core or @dispatch/db", () => {
    // If we got here, the import at the top of this test file succeeded
    // without needing core or db. The structural guarantee is in package.json.
    expect(client).toBeInstanceOf(DispatchClient);
  });
});
