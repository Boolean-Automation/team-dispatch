// dispatch — /api/tickets routes
//
// Routes:
//   GET  /api/tickets                   — list tickets with filter/sort (Clerk session auth)
//   GET  /api/tickets/:id               — get a single ticket by id (Clerk session auth)
//   POST /api/tickets                   — hand-create a ticket (Clerk session auth, ADR-005)
//   POST /api/tickets/:id/dismiss       — dismiss a ticket, undoable (Clerk session auth)
//   PATCH /api/tickets/:id/status       — change ticket status, undoable (Clerk session auth, A25)
//   PATCH /api/tickets/:id/effort-bucket — set effort bucket, undoable (Clerk session auth, A7)

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import {
  listTickets,
  getTicket,
  getTicketByDisplayId,
  TicketListQuerySchema,
  TicketStatusSchema,
  createTicketManual,
  dismissTicket,
  updateTicketStatus,
  setEffortBucket,
  isKnownEngineer,
} from "@dispatch/core";

interface TicketByIdRoute extends RouteGenericInterface {
  Params: { id: string };
}

interface PatchStatusBody {
  status: string;
}

interface CreateTicketBody {
  accountId: string;
  type?: "question" | "reply" | "thanks" | "ooo" | "other";
  body?: string;
  /** Admin-only: Clerk id of the SE to assign. Ignored for SE callers. */
  assigneeId?: string;
}

interface PatchEffortBucketBody {
  effortBucket: string;
}

const VALID_EFFORT_BUCKETS = [
  "client-specific",
  "platform-shared",
  "one-time-build",
] as const;

export default async function ticketRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/tickets
  fastify.get(
    "/api/tickets",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = TicketListQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid query parameters",
          details: parseResult.error.issues,
          statusCode: 400,
        });
      }

      const cards = await listTickets(fastify.db, parseResult.data);
      return reply.send(cards);
    }
  );

  // GET /api/tickets/:id
  // Accepts both UUID and display id (DSP-XXXX) — P1-D fix.
  // P3-A: validate id format before routing to prevent a Postgres UUID-syntax
  // error from reaching the caller as a 500.
  fastify.get<TicketByIdRoute>(
    "/api/tickets/:id",
    { preHandler: requireClerkSession },
    async (request, reply) => {
      const { id } = request.params;

      const isDsp = /^DSP-\d+$/i.test(id);
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id
        );

      if (!isDsp && !isUuid) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid ticket id",
          statusCode: 400,
        });
      }

      const dto = isDsp
        ? await getTicketByDisplayId(fastify.db, id.toUpperCase())
        : await getTicket(fastify.db, id);

      if (!dto) {
        return reply.status(404).send({
          error: "Not Found",
          message: `Ticket ${id} not found`,
          statusCode: 404,
        });
      }
      return reply.send(dto);
    }
  );

  // POST /api/tickets — hand-create a ticket (ADR-005)
  fastify.post(
    "/api/tickets",
    { preHandler: requireClerkSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Partial<CreateTicketBody>;

      if (!body.accountId || typeof body.accountId !== "string") {
        return reply.status(400).send({
          error: "Bad Request",
          message: "accountId is required",
          statusCode: 400,
        });
      }

      // Role-aware assignment (ADR-005 follow-up):
      //   SE caller    → always self-assign; an SE cannot route to anyone else.
      //   Admin caller → may pick any known engineer; omit to fall back to the
      //                  account's owning SE (createTicketManual default).
      let assigneeId: string | undefined;
      if (request.auth.role === "se") {
        assigneeId = request.auth.userId;
      } else if (typeof body.assigneeId === "string" && body.assigneeId) {
        // Validate the chosen id against the registry so a stale/bad value
        // can't silently mis-route the ticket.
        if (!(await isKnownEngineer(fastify.db, body.assigneeId))) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "assigneeId is not a known engineer",
            statusCode: 400,
          });
        }
        assigneeId = body.assigneeId;
      }

      const result = await createTicketManual({
        db: fastify.db,
        accountId: body.accountId,
        type: body.type,
        body: body.body,
        actorId: request.auth.userId,
        assigneeId,
      });

      return reply.status(201).send(result);
    }
  );

  // POST /api/tickets/:id/dismiss — soft-dismiss a ticket (undoable)
  fastify.post<TicketByIdRoute>(
    "/api/tickets/:id/dismiss",
    { preHandler: requireClerkSession },
    async (request, reply) => {
      const result = await dismissTicket(
        fastify.db,
        request.params.id,
        request.auth.userId
      );

      if (!result.ok) {
        return reply.status(404).send({
          error: "Not Found",
          message: `Ticket ${request.params.id} not found`,
          statusCode: 404,
        });
      }

      return reply.send(result);
    }
  );

  // PATCH /api/tickets/:id/status — manually change ticket status (undoable, A25)
  fastify.patch<TicketByIdRoute>(
    "/api/tickets/:id/status",
    { preHandler: requireClerkSession },
    async (request, reply) => {
      const body = request.body as Partial<PatchStatusBody>;

      // Validate status value
      const parseResult = TicketStatusSchema.safeParse(body.status);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid status value. Must be one of: ${TicketStatusSchema.options.join(", ")}`,
          statusCode: 400,
        });
      }

      const result = await updateTicketStatus(
        fastify.db,
        request.params.id,
        parseResult.data,
        request.auth.userId
      );

      if (!result.ok) {
        // Distinguish "not found" from "invalid transition"
        if (result.error?.includes("not found")) {
          return reply.status(404).send({
            error: "Not Found",
            message: result.error,
            statusCode: 404,
          });
        }
        return reply.status(422).send({
          error: "Unprocessable Entity",
          message: result.error,
          statusCode: 422,
        });
      }

      return reply.send(result);
    }
  );

  // PATCH /api/tickets/:id/effort-bucket — set effort bucket (undoable, A7)
  fastify.patch<TicketByIdRoute>(
    "/api/tickets/:id/effort-bucket",
    { preHandler: requireClerkSession },
    async (request, reply) => {
      const body = request.body as Partial<PatchEffortBucketBody>;
      const bucket = body.effortBucket;

      if (
        !bucket ||
        !VALID_EFFORT_BUCKETS.includes(
          bucket as (typeof VALID_EFFORT_BUCKETS)[number]
        )
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid effortBucket. Must be one of: ${VALID_EFFORT_BUCKETS.join(", ")}`,
          statusCode: 400,
        });
      }

      const result = await setEffortBucket(
        fastify.db,
        request.params.id,
        bucket as (typeof VALID_EFFORT_BUCKETS)[number],
        request.auth.userId
      );

      if (!result.ok) {
        if (result.error?.includes("not found")) {
          return reply.status(404).send({
            error: "Not Found",
            message: result.error,
            statusCode: 404,
          });
        }
        return reply.status(422).send({
          error: "Unprocessable Entity",
          message: result.error,
          statusCode: 422,
        });
      }

      return reply.send(result);
    }
  );
}
