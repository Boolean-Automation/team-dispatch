// dispatch — /api/accounts routes (Slice 3: read-only)
//
// Routes:
//   GET /api/accounts       — list all accounts (Clerk session auth)
//   GET /api/accounts/:id   — get a single account (Clerk session auth)

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import { listAccounts, getAccount } from "@dispatch/core";

interface AccountByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

export default async function accountRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/accounts
  fastify.get(
    "/api/accounts",
    { preHandler: requireClerkSession },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const accts = await listAccounts(fastify.db);
      return reply.send(accts);
    }
  );

  // GET /api/accounts/:id
  fastify.get<AccountByIdRoute>(
    "/api/accounts/:id",
    { preHandler: requireClerkSession },
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
