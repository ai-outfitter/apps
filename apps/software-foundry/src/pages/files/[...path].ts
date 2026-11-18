import { storageRoutes } from "@ai-outfitter/app-sdk/storage";

// Stored files at /files/<bucket>/<space>/<key> (docs/app-storage.md). Keys have
// any depth: run screenshots are <runId>/<file>, release evidence is
// <bundle>/images/<story>/<file>.png, so the route must not fix the segment count.
export const GET = storageRoutes();
export const HEAD = GET;
