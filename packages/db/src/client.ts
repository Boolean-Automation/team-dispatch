// dispatch — Drizzle database client factory
//
// createDb(url) returns a drizzle instance connected to the given Postgres URL.
// Pass DATABASE_URL from the environment.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}
