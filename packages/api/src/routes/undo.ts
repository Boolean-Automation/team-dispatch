// dispatch — undo route
//
// POST /api/undo — reverse a mutation by its undo_token (auth class a: requireClerkSession)
//
// plan §Slice 4 / spec §3.9 / A25

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import { undoByToken } from "@dispatch/core";

export default async function undoRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.post(
    "/api/undo",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { token?: string };

      if (!body.token || typeof body.token !== "string") {
        return reply.status(400).send({
          error: "Bad Request",
          message: "token is required",
          statusCode: 400,
        });
      }

      const result = await undoByToken(fastify.db, body.token);

      if (!result.ok) {
        const statusCode = result.reason === "not-found" ? 404 : 422;
        return reply.status(statusCode).send({
          error: result.reason === "not-found" ? "Not Found" : "Unprocessable",
          message: `Undo failed: ${result.reason}`,
          statusCode,
        });
      }

      return reply.send({ ok: true, action: result.action });
    }
  );
}
