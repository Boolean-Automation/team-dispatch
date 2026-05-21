// dispatch — drizzle-kit config
// Reads DATABASE_URL from env; falls back to local dispatch_dev DB.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://cody@localhost:5432/dispatch_dev",
  },
  verbose: true,
  strict: true,
});
