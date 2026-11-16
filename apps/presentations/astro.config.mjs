import { outfitterApp } from "@ai-outfitter/app-sdk/astro";
import { scriptedAgentResolution } from "@ai-outfitter/ui/scripted-agent";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

const mode = process.env.OUTFITTER_APP_MODE ?? "operational";
// The demo is read-only fixtures: pages only, never a write.
const readOnly = mode !== "operational";
const formAction = `form-action ${readOnly ? "'none'" : "'self'"}`;

export default defineConfig({
  output: "server",
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [
    react(),
    outfitterApp({
      app: "presentations",
      readOnly,
      // Pages carry Astro's hashed CSP (below); this one covers the rest.
      contentSecurityPolicy: `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; media-src 'self' https:; img-src 'self' https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; ${formAction}`,
    }),
  ],
  // The agent sidebar hydrates through inline scripts; Astro hashes them into the page's policy.
  // Client-side navigation fetches pages, so even the demo connects to its own origin.
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "font-src 'self'",
        "media-src 'self' https:; img-src 'self' blob: https:",
        "connect-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        formAction,
      ],
    },
  },
  build: { inlineStylesheets: "never" },
  vite: {
    resolve: scriptedAgentResolution(),
    define: { "import.meta.env.OUTFITTER_APP_MODE": JSON.stringify(mode) },
    build: {
      assetsInlineLimit: 0,
      rolldownOptions: { output: { chunkFileNames: "chunks/[hash].mjs" } },
    },
  },
});
