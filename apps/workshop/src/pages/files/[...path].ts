import { storageRoutes } from "@ai-outfitter/app-sdk/storage";

// Concept images at /files/main/concepts/<projectId>/<conceptId>.<ext> (docs/app-storage.md).
export const GET = storageRoutes();
export const HEAD = GET;
