import { dataAppMiddleware } from "@ai-outfitter/app-sdk/cloudflare/middleware";
import { storageManifest } from "@ai-outfitter/app-sdk/storage";
import app from "../app.json";

export const onRequest = dataAppMiddleware(
  "software-foundry",
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  import.meta.env.OUTFITTER_APP_MODE === "demo"
    ? {}
    : { storage: storageManifest.parse(app.storage) },
);
