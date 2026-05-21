// dispatch — @dispatch/db public surface
//
// Exposes: the Drizzle schema tables/enums/types, the db client factory.
// Consumed by packages/core only — web must NEVER import this package.

export * from "./schema.js";
export { createDb, type Db } from "./client.js";
