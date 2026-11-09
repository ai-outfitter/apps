import { scriptedAgentResolution } from "@ai-outfitter/ui/scripted-agent";
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "server",
  session: false,
  integrations: [react()],
  adapter: cloudflare({ imageService: "compile" }),
  build: { inlineStylesheets: "never" },
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "img-src 'self' blob: https: http:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ],
    },
  },
  vite: {
    resolve: scriptedAgentResolution(),
    define: {
      "import.meta.env.OUTFITTER_APP_MODE": JSON.stringify(
        process.env.OUTFITTER_APP_MODE ?? "operational",
      ),
    },
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
