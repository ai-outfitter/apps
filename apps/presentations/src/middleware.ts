import app from "../app.json";
import { storageManifest } from "@ai-outfitter/app-sdk/storage";
import { dataAppMiddleware } from "@ai-outfitter/app-sdk/cloudflare/middleware";

// Captures may live on another image host; the walkthrough controls when they load.
export const onRequest = dataAppMiddleware(
  "presentations",
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; media-src 'self' https:; img-src 'self' blob: https: http:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  import.meta.env.OUTFITTER_APP_MODE === "operational"
    ? { storage: storageManifest.parse(app.storage) }
    : {},
);
