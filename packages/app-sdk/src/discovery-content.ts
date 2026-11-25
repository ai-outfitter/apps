import { z } from "zod";

export const platformDiscoveryCapability = "platform.discovery";
export const discoveryConnectPath = "/api/internal/discovery/v1/connect";

const opaque = z.string().min(1).max(8192);

export const discoveryGrant = z.object({
  id: opaque,
  provider: z.string().min(1).max(80),
  repository: z.string().min(1).max(300),
  ref: z.string().min(1).max(300),
  /** A trailing slash grants a subtree; otherwise this is an exact file. */
  path: z.string().min(1).max(1024),
});
export const discoveryConnectInput = z.strictObject({ grantId: opaque });

const citation = {
  id: opaque,
  path: z.string().min(1).max(1024),
  revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  url: z.url({ protocol: /^https?$/ }).max(2048),
  changedAt: z.iso.datetime({ offset: true }),
  changedAtBasis: z.literal("commit-head"),
};
export const contentChange = z.discriminatedUnion("kind", [
  z.object({ ...citation, kind: z.literal("upsert"), body: z.string().max(65536) }).refine(change => {
    try {
      const path = decodeURIComponent(new URL(change.url).pathname);
      return path.endsWith(`/${change.revision}/${change.path}`);
    } catch { return false; }
  }, "Discovery link must pin the change's revision and path"),
  z.object({ ...citation, kind: z.literal("archive") }),
]);

export const discoveryChangesInput = z.strictObject({
  grantId: opaque,
  checkpoint: opaque.optional(),
  cursor: opaque.optional(),
});
export const discoveryChangesPage = z.object({
  changes: z.array(contentChange).max(100),
  checkpoint: opaque,
  cursor: opaque.nullable(),
});
