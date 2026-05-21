// dispatch — /api/contacts routes (Slice 3: read-only)
//
// Routes:
//   GET /api/contacts                      — list all contacts (Clerk session auth)
//   GET /api/contacts?accountId=<id>       — list contacts for an account
//   GET /api/contacts/:id                  — get a single contact

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import {
  listContacts,
  listContactsByAccount,
  getContact,
} from "@dispatch/core";

interface ContactListRoute extends RouteGenericInterface {
  Querystring: { accountId?: string };
}

interface ContactByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

export default async function contactRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/contacts  (optionally filtered by ?accountId=)
  fastify.get<ContactListRoute>(
    "/api/contacts",
    { preHandler: requireClerkSession },
    async (request, reply) => {
      const { accountId } = request.query;
      const cts = accountId
        ? await listContactsByAccount(fastify.db, accountId)
        : await listContacts(fastify.db);
      return reply.send(cts);
    }
  );

  // GET /api/contacts/:id
  fastify.get<ContactByIdRoute>(
    "/api/contacts/:id",
    { preHandler: requireClerkSession },
    async (request, reply) => {
      const dto = await getContact(fastify.db, request.params.id);
      if (!dto) {
        return reply.status(404).send({
          error: "Not Found",
          message: `Contact ${request.params.id} not found`,
          statusCode: 404,
        });
      }
      return reply.send(dto);
    }
  );
}
