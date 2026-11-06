import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";
export default defineConfig({
  output: "server",
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  build: { inlineStylesheets: "never" },
  // The app's CSP permits self-hosted scripts, never inline JavaScript.
  vite: { define: { "import.meta.env.OUTFITTER_APP_MODE": JSON.stringify(process.env.OUTFITTER_APP_MODE ?? "operational") }, worker: { format: "es" }, build: { assetsInlineLimit: 0, rolldownOptions: { output: { chunkFileNames: "chunks/[hash].mjs" } } } },
});
