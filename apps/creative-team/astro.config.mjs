import { scriptedAgentResolution } from "@ai-outfitter/ui/scripted-agent";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [react()],
  // The agent sidebar hydrates through inline scripts; Astro hashes them into the page's policy.
  // Client-side navigation fetches pages, so even the demo connects to its own origin.
  security: {
    csp: {
      directives: ["default-src 'none'", "font-src 'self'", "img-src 'self' blob:", "connect-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", `form-action ${process.env.OUTFITTER_APP_MODE === "operational" ? "'self'" : "'none'"}`],
    },
  },
  build: { inlineStylesheets: "never" },
  vite: {
    resolve: scriptedAgentResolution(),
    define: { "import.meta.env.OUTFITTER_APP_MODE": JSON.stringify(process.env.OUTFITTER_APP_MODE ?? "operational") },
    build: { assetsInlineLimit: 0, rolldownOptions: { output: { chunkFileNames: "chunks/[hash].mjs" } } },
  },
});
