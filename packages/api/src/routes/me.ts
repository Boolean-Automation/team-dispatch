// dispatch — GET /api/me route
// Returns the authenticated SE's identity (userId + role).
// Auth class: (a) requireClerkSession — Clerk session JWT.
//
// The web app calls this on mount to populate the rail footer and seed the
// signed-in engineer identity used throughout the UI.

import type { FastifyInstance } from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";

export default async function meRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/api/me",
    { preHandler: [requireClerkSession] },
    async (request, _reply) => {
      return {
        userId: request.auth.userId,
        role: request.auth.role,
      };
    }
  );
}
