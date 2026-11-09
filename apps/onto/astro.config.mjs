import { scriptedAgentResolution } from "@ai-outfitter/ui/scripted-agent";
import react from "@astrojs/react";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

execFileSync(
  process.execPath,
  [
    "--import",
    "tsx",
    fileURLToPath(new URL("./scripts/check-seeds.ts", import.meta.url)),
  ],
  { stdio: "inherit" },
);

export default defineConfig({
  output: "server",
  integrations: [react()],
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
  vite: {
    resolve: scriptedAgentResolution(),
    define: {
      // The package mode picks the data adapter at build time: fixtures or the API.
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
