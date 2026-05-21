// dispatch — error-handler Fastify plugin
// Converts thrown errors into consistent JSON responses.
// Every route handler can `throw` a plain Error with a `statusCode` property
// and this plugin will serialise it correctly.

import type { FastifyInstance, FastifyError } from "fastify";
import fp from "fastify-plugin";

export interface DispatchError extends FastifyError {
  statusCode: number;
}

async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = (error as DispatchError).statusCode ?? error.statusCode ?? 500;

    // Don't log 4xx as errors — they're expected flow
    if (status >= 500) {
      fastify.log.error({ err: error }, "Unhandled server error");
    }

    return reply.status(status).send({
      error: error.name ?? "Error",
      message: error.message,
      statusCode: status,
    });
  });
}

// Wrap with fastify-plugin so the encapsulation scope doesn't isolate it
export default fp(errorHandlerPlugin, {
  name: "error-handler",
  fastify: "4.x",
});
