// dispatch — /api/tickets routes
//
// Routes:
//   GET /api/tickets       — list tickets with filter/sort (Clerk session auth)
//   GET /api/tickets/:id   — get a single ticket by id (Clerk session auth)
//   POST /api/tickets      — hand-create a ticket (Clerk session auth, ADR-005)
//   POST /api/tickets/:id/dismiss — dismiss a ticket, undoable (Clerk session auth)

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import {
  listTickets,
  getTicket,
  TicketListQuerySchema,
  createTicketManual,
  dismissTicket,
} from "@dispatch/core";

interface TicketByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

interface CreateTicketBody {
  accountId: string;
  type?: "question" | "reply" | "thanks" | "ooo" | "other";
  body?: string;
}

export default async function ticketRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/tickets
  fastify.get(
    "/api/tickets",
    { preHandler: requireClerkSession },
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

  // GET /api/tickets/:id
  fastify.get<TicketByIdRoute>(
    "/api/tickets/:id",
    { preHandler: requireClerkSession },
    async (request, reply) => {
      const dto = await getTicket(fastify.db, request.params.id);
      if (!dto) {
        return reply.status(404).send({
          error: "Not Found",
          message: `Ticket ${request.params.id} not found`,
          statusCode: 404,
        });
      }
      return reply.send(dto);
    }
  );

  // POST /api/tickets — hand-create a ticket (ADR-005)
  fastify.post(
    "/api/tickets",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Partial<CreateTicketBody>;

      if (!body.accountId || typeof body.accountId !== "string") {
        return reply.status(400).send({
          error: "Bad Request",
          message: "accountId is required",
          statusCode: 400,
        });
      }

      const result = await createTicketManual({
        db: fastify.db,
        accountId: body.accountId,
        type: body.type,
        body: body.body,
        actorId: request.auth.userId,
      });

      return reply.status(201).send(result);
    }
  );

  // POST /api/tickets/:id/dismiss — soft-dismiss a ticket (undoable)
  fastify.post<TicketByIdRoute>(
    "/api/tickets/:id/dismiss",
    { preHandler: requireClerkSession },
    async (request, reply) => {
      const result = await dismissTicket(
        fastify.db,
        request.params.id,
        request.auth.userId
      );

      if (!result.ok) {
        return reply.status(404).send({
          error: "Not Found",
          message: `Ticket ${request.params.id} not found`,
          statusCode: 404,
        });
      }

      return reply.send(result);
    }
  );
}
