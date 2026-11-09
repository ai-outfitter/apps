import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";
import { outfitterApp } from "@ai-outfitter/app-sdk/astro";
import app from "./app.json" with { type: "json" };
export default defineConfig({
  output: "server",
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [
    outfitterApp({
      app: "workshop",
      // Concept images load from the app's own files.
      contentSecurityPolicy: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      storage: process.env.OUTFITTER_APP_MODE === "demo" ? undefined : app.storage,
    }),
  ],
  build: { inlineStylesheets: "never" },
  // The app's CSP permits self-hosted scripts, never inline JavaScript.
  vite: { define: { "import.meta.env.OUTFITTER_APP_MODE": JSON.stringify(process.env.OUTFITTER_APP_MODE ?? "operational") }, worker: { format: "es" }, build: { assetsInlineLimit: 0, rolldownOptions: { output: { chunkFileNames: "chunks/[hash].mjs" } } } },
});
