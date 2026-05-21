// dispatch — notifications routes
//
// GET /api/notifications — list notifications for the authenticated SE
//
// plan §Slice 4 / spec §3.11

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import { listNotifications, markNotificationRead } from "@dispatch/core";

interface NotifByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

export default async function notificationRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/notifications
  fastify.get(
    "/api/notifications",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const notifs = await listNotifications(
        fastify.db,
        request.auth.userId
      );
      return reply.send(notifs);
    }
  );

  // POST /api/notifications/:id/read — mark a notification as read
  fastify.post<NotifByIdRoute>(
    "/api/notifications/:id/read",
    { preHandler: requireClerkSession },
    async (request, reply: FastifyReply) => {
      await markNotificationRead(fastify.db, request.params.id);
      return reply.send({ ok: true });
    }
  );
}
