import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./apps/forerunner/src/server/schema.ts", out: "./apps/forerunner/migrations" });
