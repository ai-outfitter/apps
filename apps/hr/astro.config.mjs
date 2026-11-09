import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { outfitterApp } from "@ai-outfitter/app-sdk/astro";
export default defineConfig({
  output: "server",
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [
    outfitterApp({
      app: "hr",
      readOnly: true,
      contentSecurityPolicy: "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    }),
  ],
  build: { inlineStylesheets: "never" },
  // The app's CSP permits self-hosted scripts, never inline JavaScript.
  vite: { define: { "import.meta.env.OUTFITTER_APP_MODE": JSON.stringify(process.env.OUTFITTER_APP_MODE ?? "operational") }, build: { assetsInlineLimit: 0 } },
});
