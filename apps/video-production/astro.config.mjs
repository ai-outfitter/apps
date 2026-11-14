import { outfitterApp } from "@ai-outfitter/app-sdk/astro";
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

const mode = process.env.OUTFITTER_APP_MODE ?? "operational";

// Pages only read; every write is an Onto change batch staged through graph.mutate.
export default defineConfig({
  output: "server",
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [
    outfitterApp({
      app: "video-production",
      readOnly: true,
      contentSecurityPolicy: "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    }),
  ],
  // Client-side navigation fetches pages, so even the demo connects to its own origin.
  security: {
    csp: {
      directives: ["default-src 'none'", "font-src 'self'", "img-src 'self'", "connect-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"],
    },
  },
  build: { inlineStylesheets: "never" },
  vite: {
    define: { "import.meta.env.OUTFITTER_APP_MODE": JSON.stringify(mode) },
    build: { assetsInlineLimit: 0, rolldownOptions: { output: { chunkFileNames: "chunks/[hash].mjs" } } },
  },
});
