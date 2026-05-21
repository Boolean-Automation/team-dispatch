// dispatch — /api/accounts routes
//
// Routes:
//   GET   /api/accounts         — list all accounts (Clerk session auth)
//   GET   /api/accounts/:id     — get a single account (Clerk session auth)
//   PATCH /api/accounts/:id/highlights — edit Account Highlights (Clerk session auth)
//
// Slice 5: adds the highlights edit endpoint.

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import {
  listAccounts,
  getAccount,
  updateAccountHighlights,
} from "@dispatch/core";

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

  // PATCH /api/accounts/:id/highlights — edit Account Highlights (Slice 5)
  fastify.patch<AccountByIdRoute>(
    "/api/accounts/:id/highlights",
    { preHandler: requireClerkSession },
    async (
      request: FastifyRequest<AccountByIdRoute>,
      reply: FastifyReply
    ) => {
      const body = request.body as { highlights?: string };

      if (typeof body.highlights !== "string") {
        return reply.status(400).send({
          error: "Bad Request",
          message: "highlights must be a string",
          statusCode: 400,
        });
      }

      const result = await updateAccountHighlights(
        fastify.db,
        request.params.id,
        body.highlights,
        request.auth.userId
      );

      if (!result.ok) {
        return reply.status(404).send({
          error: "Not Found",
          message: `Account ${request.params.id} not found`,
          statusCode: 404,
        });
      }

      return reply.send(result.account);
    }
  );
}
