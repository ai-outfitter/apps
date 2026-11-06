import { defineConfig } from "drizzle-kit";

// The installation database's schema (docs/app-databases.md).
export default defineConfig({
  dialect: "sqlite",
  schema: "./apps/workshop/src/server/schema.ts",
  out: "./apps/workshop/migrations",
});
