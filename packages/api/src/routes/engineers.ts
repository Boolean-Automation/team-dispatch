// dispatch — GET /api/engineers route
//
// Lists internal users (engineers) from the authoritative internal_users
// registry. Powers the admin assignee picker in the hand-create flow.
// Auth class: (a) requireClerkSession — any signed-in user may read the list.

import type { FastifyInstance } from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import { listEngineers } from "@dispatch/core";

export default async function engineerRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.get(
    "/api/engineers",
    { preHandler: [requireClerkSession] },
    async (_request, reply) => {
      const engineers = await listEngineers(fastify.db);
      return reply.send(engineers);
    }
  );
}
