import { storageManifest } from "@ai-outfitter/app-sdk/storage";
import { dataAppMiddleware } from "@ai-outfitter/app-sdk/cloudflare/middleware";
import app from "../app.json";

// Concept images load from the app's own files.
export const onRequest = dataAppMiddleware(
  "workshop",
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  import.meta.env.OUTFITTER_APP_MODE === "demo"
    ? {}
    : { storage: storageManifest.parse(app.storage) },
);
