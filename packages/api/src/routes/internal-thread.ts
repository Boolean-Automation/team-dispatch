// dispatch — /api/tickets/:id/internal-thread routes
//
// Routes:
//   GET  /api/tickets/:id/internal-thread  — list internal thread messages
//   POST /api/tickets/:id/internal-thread  — post a message (returns undoToken)
//
// Internal thread messages are dispatch-native only. NEVER written to Slack
// (spec §3.8, A21). No channel tag on render (OQ-3).
//
// plan §Slice 7

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import {
  listInternalThreadMessages,
  postInternalMessage,
} from "@dispatch/core";

interface TicketByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

interface PostInternalMessageBody {
  body: string;
}

export default async function internalThreadRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/tickets/:id/internal-thread — list internal thread messages
  fastify.get<TicketByIdRoute>(
    "/api/tickets/:id/internal-thread",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest<TicketByIdRoute>, reply: FastifyReply) => {
      const msgs = await listInternalThreadMessages(
        fastify.db,
        request.params.id
      );
      return reply.send(msgs);
    }
  );

  // POST /api/tickets/:id/internal-thread — post an internal message
  fastify.post<TicketByIdRoute>(
    "/api/tickets/:id/internal-thread",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest<TicketByIdRoute>, reply: FastifyReply) => {
      const body = request.body as Partial<PostInternalMessageBody>;

      if (!body.body || typeof body.body !== "string" || !body.body.trim()) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "body is required",
          statusCode: 400,
        });
      }

      try {
        const result = await postInternalMessage(
          fastify.db,
          request.params.id,
          request.auth.userId,
          body.body.trim()
        );
        return reply.status(201).send({
          message: result.message,
          undoToken: result.undoToken,
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
