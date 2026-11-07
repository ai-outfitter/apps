import { storageRoutes } from "@ai-outfitter/app-sdk/storage";

// A page's files at /files/main/assets/<pageId>/<file> (docs/app-storage.md).
export const GET = storageRoutes();
export const HEAD = GET;
