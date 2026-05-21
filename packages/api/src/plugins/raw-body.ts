// dispatch — raw-body Fastify plugin
//
// Stores the raw request body string on request.rawBody so the Slack
// HMAC signature verifier can compute the signature against the exact
// bytes received (not a re-serialized JSON body).
//
// Registers a content-type parser for application/json that:
//   1. Stores the raw buffer as request.rawBody (string)
//   2. Parses it as JSON and returns the parsed value as the body
//
// This replaces Fastify's default JSON content-type parser.

import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

// Augment FastifyRequest to carry rawBody
declare module "fastify" {
  interface FastifyRequest {
    rawBody: string;
  }
}

async function rawBodyPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest("rawBody", "");

  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    function (_req: FastifyRequest, body: string, done) {
      (_req as FastifyRequest & { rawBody: string }).rawBody = body;
      try {
        const parsed = body ? (JSON.parse(body) as unknown) : {};
        done(null, parsed);
      } catch (err) {
        const parseErr = new Error(
          `Failed to parse JSON: ${(err as Error).message}`
        ) as Error & { statusCode: number };
        parseErr.statusCode = 400;
        done(parseErr, undefined);
      }
    }
  );
}

export default fp(rawBodyPlugin, {
  name: "raw-body",
  fastify: "4.x",
});
