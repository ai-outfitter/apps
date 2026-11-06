import { storageRoutes } from "@ai-outfitter/app-sdk/storage";

// Run files, such as published demo screenshots, at /files/main/runs/<runId>/<file>
// (docs/app-storage.md). Every key Foundry stores has this depth.
export const GET = storageRoutes();
export const HEAD = GET;
