// dispatch — activity route
//
// GET /api/tickets/:id/activity — reads audit_log for the ticket detail Activity panel
//
// plan §Slice 4 / §3 cross-cutting concerns

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import { getTicketActivity } from "@dispatch/core";

interface ActivityRoute extends RouteGenericInterface {
  Params: { id: string };
}

export default async function activityRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.get<ActivityRoute>(
    "/api/tickets/:id/activity",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest<ActivityRoute>, reply: FastifyReply) => {
      const entries = await getTicketActivity(fastify.db, request.params.id);
      return reply.send(entries);
    }
  );
}
