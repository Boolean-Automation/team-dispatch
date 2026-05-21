// dispatch — /api/tickets/:id/messages routes
//
// Routes:
//   POST /api/tickets/:id/messages — send a reply (Clerk session auth)
//     Creates an outbound Message + inserts a pending slack_outbox row.
//     Returns the Message + undoToken. The actual Slack send fires after the
//     undo window (outbox worker); undo within the window cancels the row.
//   GET  /api/tickets/:id/messages — list messages for a ticket (Clerk session auth)
//
// plan §Slice 5

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import { sendReply, listMessagesByTicket } from "@dispatch/core";

interface TicketByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

interface SendReplyBody {
  body: string;
  actorName: string;
  actorIconUrl?: string;
  resolve?: boolean;
}

export default async function messageRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/tickets/:id/messages — list messages for a ticket
  fastify.get<TicketByIdRoute>(
    "/api/tickets/:id/messages",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest<TicketByIdRoute>, reply: FastifyReply) => {
      const msgs = await listMessagesByTicket(fastify.db, request.params.id);
      return reply.send(msgs);
    }
  );

  // POST /api/tickets/:id/messages — send a reply
  fastify.post<TicketByIdRoute>(
    "/api/tickets/:id/messages",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest<TicketByIdRoute>, reply: FastifyReply) => {
      const body = request.body as Partial<SendReplyBody>;

      if (!body.body || typeof body.body !== "string" || !body.body.trim()) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "body is required",
          statusCode: 400,
        });
      }

      const actorName =
        typeof body.actorName === "string" && body.actorName.trim()
          ? body.actorName.trim()
          : request.auth.userId;

      try {
        const result = await sendReply({
          db: fastify.db,
          ticketId: request.params.id,
          actorId: request.auth.userId,
          body: body.body.trim(),
          actorName,
          actorIconUrl: body.actorIconUrl,
          resolveTicket: body.resolve === true,
        });

        return reply.status(201).send({
          message: result.message,
          undoToken: result.undoToken,
          outboxId: result.outboxId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message.includes("not found")) {
          return reply.status(404).send({
            error: "Not Found",
            message,
            statusCode: 404,
          });
        }
        throw err;
      }
    }
  );
}
