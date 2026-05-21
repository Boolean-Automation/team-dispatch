// dispatch — /api/tickets/:id/reinforcements routes
//
// Routes:
//   POST   /api/tickets/:id/reinforcements            — add collaborator
//   DELETE /api/tickets/:id/reinforcements/:userId    — remove collaborator
//   GET    /api/tickets/:id/reinforcements            — list collaborators
//
// Adding a reinforcement puts the ticket in the collaborator's Shared Issues
// view. tickets.assignee is unchanged (A27). Both add and remove are undoable.
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
  addReinforcement,
  removeReinforcement,
  listReinforcementsForTicket,
} from "@dispatch/core";

interface TicketByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

interface ReinforcementUserRoute extends RouteGenericInterface {
  Params: { id: string; userId: string };
}

interface AddReinforcementBody {
  collaboratorId: string;
}

export default async function reinforcementRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/tickets/:id/reinforcements — list collaborators
  fastify.get<TicketByIdRoute>(
    "/api/tickets/:id/reinforcements",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest<TicketByIdRoute>, reply: FastifyReply) => {
      const list = await listReinforcementsForTicket(
        fastify.db,
        request.params.id
      );
      return reply.send(list);
    }
  );

  // POST /api/tickets/:id/reinforcements — add collaborator
  fastify.post<TicketByIdRoute>(
    "/api/tickets/:id/reinforcements",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest<TicketByIdRoute>, reply: FastifyReply) => {
      const body = request.body as Partial<AddReinforcementBody>;

      if (
        !body.collaboratorId ||
        typeof body.collaboratorId !== "string" ||
        !body.collaboratorId.trim()
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "collaboratorId is required",
          statusCode: 400,
        });
      }

      const result = await addReinforcement(
        fastify.db,
        request.params.id,
        body.collaboratorId.trim(),
        request.auth.userId
      );

      if (!result.ok) {
        const statusCode = result.error?.includes("not found") ? 404 : 400;
        return reply.status(statusCode).send({
          error: statusCode === 404 ? "Not Found" : "Bad Request",
          message: result.error,
          statusCode,
        });
      }

      return reply.status(201).send({
        reinforcement: result.reinforcement,
        undoToken: result.undoToken,
      });
    }
  );

  // DELETE /api/tickets/:id/reinforcements/:userId — remove collaborator
  fastify.delete<ReinforcementUserRoute>(
    "/api/tickets/:id/reinforcements/:userId",
    { preHandler: requireClerkSession },
    async (
      request: FastifyRequest<ReinforcementUserRoute>,
      reply: FastifyReply
    ) => {
      const result = await removeReinforcement(
        fastify.db,
        request.params.id,
        request.params.userId,
        request.auth.userId
      );

      if (!result.ok) {
        const statusCode = result.error?.includes("not found") ? 404 : 400;
        return reply.status(statusCode).send({
          error: statusCode === 404 ? "Not Found" : "Bad Request",
          message: result.error,
          statusCode,
        });
      }

      return reply.status(200).send({ undoToken: result.undoToken });
    }
  );
}
