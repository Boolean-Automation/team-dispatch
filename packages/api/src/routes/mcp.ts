// dispatch — /api/mcp/* routes
//
// MCP-facing read-only API. Uses requireMachineCredential (auth class d),
// NOT requireClerkSession. A Clerk session JWT is rejected here; a machine
// credential is rejected on the session routes. The two auth classes are
// mutually non-interchangeable (plan.md §3, FIX 8).
//
// Routes:
//   GET /api/mcp/tickets          — list tickets (same core service as /api/tickets)
//   GET /api/mcp/tickets/:id      — get ticket by UUID or DSP- display id
//   GET /api/mcp/accounts         — list all accounts
//   GET /api/mcp/accounts/:id     — get a single account
//
// These call the SAME core services that the session-authed /api/tickets etc.
// call — no duplicated business logic. Thin wrappers only.

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireMachineCredential } from "../plugins/clerk-auth.js";
import {
  listTickets,
  getTicket,
  getTicketByDisplayId,
  TicketListQuerySchema,
  listAccounts,
  getAccount,
} from "@dispatch/core";

interface McpByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

export default async function mcpRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/mcp/tickets
  fastify.get(
    "/api/mcp/tickets",
    { preHandler: requireMachineCredential },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = TicketListQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid query parameters",
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const cards = await listTickets(fastify.db, parseResult.data);
      return reply.send(cards);
    }
  );

  // GET /api/mcp/tickets/:id
  // Accepts both UUID and DSP- display id (mirrors the session route fix).
  // P3-A: validate id format before routing to prevent a Postgres UUID-syntax
  // error from reaching the caller as a 500.
  fastify.get<McpByIdRoute>(
    "/api/mcp/tickets/:id",
    { preHandler: requireMachineCredential },
    async (request, reply) => {
      const { id } = request.params;

      const isDsp = /^DSP-\d+$/i.test(id);
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id
        );

      if (!isDsp && !isUuid) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid ticket id",
          statusCode: 400,
        });
      }

      const dto = isDsp
        ? await getTicketByDisplayId(fastify.db, id.toUpperCase())
        : await getTicket(fastify.db, id);

      if (!dto) {
        return reply.status(404).send({
          error: "Not Found",
          message: `Ticket ${id} not found`,
          statusCode: 404,
        });
      }
      return reply.send(dto);
    }
  );

  // GET /api/mcp/accounts
  fastify.get(
    "/api/mcp/accounts",
    { preHandler: requireMachineCredential },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const accts = await listAccounts(fastify.db);
      return reply.send(accts);
    }
  );

  // GET /api/mcp/accounts/:id
  fastify.get<McpByIdRoute>(
    "/api/mcp/accounts/:id",
    { preHandler: requireMachineCredential },
    async (request, reply) => {
      const dto = await getAccount(fastify.db, request.params.id);
      if (!dto) {
        return reply.status(404).send({
          error: "Not Found",
          message: `Account ${request.params.id} not found`,
          statusCode: 404,
        });
      }
      return reply.send(dto);
    }
  );
}
