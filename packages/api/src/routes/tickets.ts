// dispatch — /api/tickets routes (Slice 3: read-only)
//
// Routes:
//   GET /api/tickets       — list tickets with filter/sort (Clerk session auth)
//   GET /api/tickets/:id   — get a single ticket by id (Clerk session auth)

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import { listTickets, getTicket, TicketListQuerySchema } from "@dispatch/core";

interface TicketByIdRoute extends RouteGenericInterface {
  Params: { id: string };
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
}
