import { dataAppMiddleware } from "@ai-outfitter/app-sdk/cloudflare/middleware";
import { storageManifest } from "@ai-outfitter/app-sdk/storage";
import app from "../app.json";

// Pages are GET only; every /api/* request must carry the member identity the
// platform forwards. Images load from the app's own files.
export const onRequest = dataAppMiddleware(
  "wiki-map",
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  import.meta.env.OUTFITTER_APP_MODE === "demo"
    ? {}
    : { storage: storageManifest.parse(app.storage) },
);
