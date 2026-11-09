import { scriptedAgentResolution } from "@ai-outfitter/ui/scripted-agent";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [react()],
  markdown: { syntaxHighlight: false },
  // React islands hydrate through inline scripts; Astro hashes them into the page's policy.
  // Client-side navigation fetches pages, so even the demo connects to its own origin.
  security: {
    csp: {
      directives: ["default-src 'none'", "font-src 'self'", "img-src 'self' blob:", "connect-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", `form-action ${process.env.OUTFITTER_APP_MODE === "operational" ? "'self'" : "'none'"}`],
    },
  },
  build: { inlineStylesheets: "never" },
  vite: {
    // Demo builds bundle the scripted sidebar, which makes no requests.
    resolve: scriptedAgentResolution(),
    define: { "import.meta.env.OUTFITTER_APP_MODE": JSON.stringify(process.env.OUTFITTER_APP_MODE ?? "operational") },
    // Chunks a script loads later (the agent sidebar's Markdown parser) are addressed
    // relative to the script, as in Chat, so they load under a personal installation's
    // /apps/<slug>/ path too, not from the root /_astro/ its CSP blocks.
    experimental: { renderBuiltUrl: (_file, { hostType }) => (hostType === "js" ? { relative: true } : undefined) },
    build: {
      assetsInlineLimit: 0,
      rolldownOptions: { output: { chunkFileNames: "chunks/[hash].mjs" } },
    },
  },
});
