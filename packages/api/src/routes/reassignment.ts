// dispatch — /api/tickets/:id/reassign routes
//
// Routes:
//   POST /api/tickets/:id/reassign         — initiate reassignment
//   POST /api/tickets/:id/reassign/accept  — recipient accepts (SE-initiated only)
//   POST /api/tickets/:id/reassign/reject  — recipient rejects (SE-initiated only)
//
// State machine (A26):
//   SE-initiated  → status='pending'; assignee unchanged until accept
//   Admin-initiated → status='accepted'; assignee moves immediately
//   Accept → assignee moves to recipient
//   Reject → assignee unchanged
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
  initiateReassignment,
  acceptReassignment,
  rejectReassignment,
} from "@dispatch/core";

interface TicketByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

interface ReassignBody {
  recipientId: string;
}

interface ReassignmentIdParams extends RouteGenericInterface {
  Params: { id: string; reassignmentId: string };
}

export default async function reassignmentRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // POST /api/tickets/:id/reassign — initiate a reassignment
  fastify.post<TicketByIdRoute>(
    "/api/tickets/:id/reassign",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest<TicketByIdRoute>, reply: FastifyReply) => {
      const body = request.body as Partial<ReassignBody>;

      if (
        !body.recipientId ||
        typeof body.recipientId !== "string" ||
        !body.recipientId.trim()
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "recipientId is required",
          statusCode: 400,
        });
      }

      const role = (request.auth.role as "admin" | "se") ?? "se";

      const result = await initiateReassignment(
        fastify.db,
        request.params.id,
        request.auth.userId,
        body.recipientId.trim(),
        role
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
        reassignment: result.reassignment,
        undoToken: result.undoToken,
      });
    }
  );

  // POST /api/tickets/:id/reassign/:reassignmentId/accept — recipient accepts
  fastify.post<ReassignmentIdParams>(
    "/api/tickets/:id/reassign/:reassignmentId/accept",
    { preHandler: requireClerkSession },
    async (
      request: FastifyRequest<ReassignmentIdParams>,
      reply: FastifyReply
    ) => {
      const result = await acceptReassignment(
        fastify.db,
        request.params.reassignmentId,
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

      return reply.status(200).send({
        reassignment: result.reassignment,
        undoToken: result.undoToken,
      });
    }
  );

  // POST /api/tickets/:id/reassign/:reassignmentId/reject — recipient rejects
  fastify.post<ReassignmentIdParams>(
    "/api/tickets/:id/reassign/:reassignmentId/reject",
    { preHandler: requireClerkSession },
    async (
      request: FastifyRequest<ReassignmentIdParams>,
      reply: FastifyReply
    ) => {
      const result = await rejectReassignment(
        fastify.db,
        request.params.reassignmentId,
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

      return reply.status(200).send({
        reassignment: result.reassignment,
        undoToken: result.undoToken,
      });
    }
  );
}
