// dispatch MCP — tool definitions
//
// Registers the four Phase-1 read tools on the McpServer instance:
//   list_tickets   — list tickets with optional filters
//   get_ticket     — get a single ticket by UUID or DSP- display id
//   list_accounts  — list all accounts
//   get_account    — get a single account by UUID
//
// Each tool is a thin wrapper: build the HTTP request, call the client,
// return the JSON. No business logic lives here — that's in @dispatch/core,
// accessible only through the dispatch HTTP API.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DispatchClient } from "./client.js";

/** Register all dispatch read tools on the given McpServer. */
export function registerTools(server: McpServer, client: DispatchClient): void {
  // ── list_tickets ────────────────────────────────────────────────────────────
  server.tool(
    "list_tickets",
    "List dispatch tickets. Supports optional filters: status, assignedTo, accountId, type.",
    {
      status: z
        .string()
        .optional()
        .describe(
          "Filter by ticket status (e.g. new, open, waiting-on-client, follow-up-required, dismissed, closed)"
        ),
      assignedTo: z
        .string()
        .optional()
        .describe("Filter by assigned Clerk user ID"),
      accountId: z.string().optional().describe("Filter by account UUID"),
      type: z
        .string()
        .optional()
        .describe("Filter by ticket type (question, reply, thanks, ooo, other)"),
    },
    async ({ status, assignedTo, accountId, type }) => {
      const query: Record<string, string> = {};
      if (status) query.status = status;
      if (assignedTo) query.assignedTo = assignedTo;
      if (accountId) query.accountId = accountId;
      if (type) query.type = type;

      const tickets = await client.listTickets(
        Object.keys(query).length > 0 ? query : undefined
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(tickets, null, 2),
          },
        ],
      };
    }
  );

  // ── get_ticket ──────────────────────────────────────────────────────────────
  server.tool(
    "get_ticket",
    "Get a single dispatch ticket by UUID or DSP- display id (e.g. DSP-2901).",
    {
      id: z
        .string()
        .describe("Ticket UUID or DSP- display id (e.g. DSP-2901)"),
    },
    async ({ id }) => {
      const ticket = await client.getTicket(id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(ticket, null, 2),
          },
        ],
      };
    }
  );

  // ── list_accounts ───────────────────────────────────────────────────────────
  server.tool(
    "list_accounts",
    "List all client accounts in dispatch.",
    {},
    async () => {
      const accounts = await client.listAccounts();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(accounts, null, 2),
          },
        ],
      };
    }
  );

  // ── get_account ─────────────────────────────────────────────────────────────
  server.tool(
    "get_account",
    "Get a single client account by UUID.",
    {
      id: z.string().describe("Account UUID"),
    },
    async ({ id }) => {
      const account = await client.getAccount(id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(account, null, 2),
          },
        ],
      };
    }
  );
}
