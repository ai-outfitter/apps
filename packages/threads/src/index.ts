/** Platform thread service. Apps use `@ai-outfitter/app-sdk/threads`, never this package. */
export { createThreadService, type ThreadService } from "./service";
export { threadBrowserRequest } from "./browser";
export { LEASE_MS, REPLY_TIMEOUT_MS } from "./reply";
export { MAX_THREAD_BYTES, MAX_THREAD_FILES, objectKey, PENDING_MS } from "./attachments";
export { visibleTo, toThread, toEntry } from "./rows";
export type { ThreadAdapters, ThreadDatabase, ThreadObjects, ThreadInference, ThreadAccounting, ThreadProviders, ThreadPrincipal } from "./types";
