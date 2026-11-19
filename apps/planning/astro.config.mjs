import { scriptedAgentResolution } from "@ai-outfitter/ui/scripted-agent";
import { outfitterApp } from "@ai-outfitter/app-sdk/astro";
import app from "./app.json" with { type: "json" };
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "server",
  session: false,
  integrations: [
    react(),
    outfitterApp({
      app: "planning",
      contentSecurityPolicy: "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; media-src 'self' https:; img-src 'self' blob: https: http:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      storage: process.env.OUTFITTER_APP_MODE === "demo" ? undefined : app.storage,
    }),
  ],
  adapter: cloudflare({ imageService: "compile" }),
  build: { inlineStylesheets: "never" },
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "img-src 'self' blob: https: http:",
        "media-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ],
    },
  },
  vite: {
    // Prebundle the sidebar dependencies together so the first SSR request uses one React runtime.
    environments: { ssr: { optimizeDeps: { include: [
      "@ai-sdk/react", "ai", "highlight.js/lib/core",
      "highlight.js/lib/languages/json", "highlight.js/lib/languages/markdown",
    ] } } },
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
