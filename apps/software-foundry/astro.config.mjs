import { scriptedAgentResolution } from "@ai-outfitter/ui/scripted-agent";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import { outfitterApp } from "@ai-outfitter/app-sdk/astro";
import app from "./app.json" with { type: "json" };
import cloudflare from "@astrojs/cloudflare";
export default defineConfig({
  output: "server",
  integrations: [
    react(),
    outfitterApp({
      app: "software-foundry",
      contentSecurityPolicy: "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      storage: process.env.OUTFITTER_APP_MODE === "demo" ? undefined : app.storage,
    }),
  ],
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "img-src 'self' https: data:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ],
    },
  },
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  build: { inlineStylesheets: "never" },
  // Keep shared scripts external under the template CSP.
  vite: {
    resolve: scriptedAgentResolution(),
    define: {
      "import.meta.env.OUTFITTER_APP_MODE": JSON.stringify(
        process.env.OUTFITTER_APP_MODE ?? "operational",
      ),
    },
    build: {
      assetsInlineLimit: 0,
      rolldownOptions: { output: { chunkFileNames: "chunks/[hash].mjs" } },
    },
  },
});
