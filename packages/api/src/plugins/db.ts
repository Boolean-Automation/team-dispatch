// dispatch — Fastify db plugin
//
// Creates the Drizzle db client from DATABASE_URL and decorates
// the Fastify instance with `fastify.db`.
//
// Tests can inject a pre-built db instance via options.db.

import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { createDb, type Db } from "@dispatch/db";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

interface DbPluginOptions {
  /** Inject a pre-built db for tests. If omitted, reads DATABASE_URL. */
  db?: Db;
}

async function dbPlugin(
  fastify: FastifyInstance,
  opts: DbPluginOptions
): Promise<void> {
  const db =
    opts.db ??
    createDb(
      process.env.DATABASE_URL ?? "postgresql://cody@localhost:5432/dispatch_dev"
    );
  fastify.decorate("db", db);
}

export default fp(dbPlugin, {
  name: "dispatch-db",
  fastify: "4.x",
});
