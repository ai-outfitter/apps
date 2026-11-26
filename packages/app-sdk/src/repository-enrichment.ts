import { z } from "zod";

export const repositoryEnrichmentCapability = "platform.repository-enrichment";
export const repositoryEnrichmentInput = z.strictObject({
  repository: z.string().trim().min(3).max(500),
});
export const repositoryEnrichmentOutput = z.object({
  repository: z.url({ protocol: /^https$/ }),
  provider: z.enum(["forgejo", "github"]),
  revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  files: z.array(z.object({
    path: z.string().min(1).max(1024),
    url: z.url({ protocol: /^https$/ }),
    text: z.string().max(1600),
  })).max(12),
});
