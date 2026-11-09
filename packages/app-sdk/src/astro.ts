import { writeFileSync } from "node:fs";
import type { AstroIntegration } from "astro";
import type { AppMiddlewareOptions } from "./cloudflare/middleware";

/**
 * The standard Outfitter app request contract, so an app needs no
 * `src/middleware.ts`: `/__health`, GET/HEAD-only pages, forwarded identity on
 * `/api/*`, `Cache-Control: private, no-store`, `nosniff`, and
 * `contentSecurityPolicy` on built responses without one of their own.
 */
export function outfitterApp(options: AppMiddlewareOptions): AstroIntegration {
  return {
    name: "@ai-outfitter/app-sdk",
    hooks: {
      "astro:config:setup": ({ addMiddleware, createCodegenDir }) => {
        const entrypoint = new URL("middleware.mjs", createCodegenDir());
        writeFileSync(
          entrypoint,
          `import { appMiddleware } from "@ai-outfitter/app-sdk/cloudflare/middleware";\nexport const onRequest = appMiddleware(${JSON.stringify(options)});\n`,
        );
        addMiddleware({ entrypoint, order: "pre" });
      },
    },
  };
}
