import { z } from "zod";

/**
 * Shared artifact and evidence citations (docs/architecture/evidence.md).
 * This module has no Wiki dependency: assertions, batch operations,
 * assessments and app records import it directly.
 */

/** Names one artifact in its home system. An artifact makes no claim. */
export const artifactRef = z.strictObject({
  provider: z.string().min(1).max(100),
  recordId: z.string().min(1).max(500),
  /** Opaque, provider-defined version; omit for immutable sources. */
  version: z.string().min(1).max(200).optional(),
  uri: z.url({ protocol: /^https?$/ }).optional(),
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ArtifactRef = z.infer<typeof artifactRef>;

/** One citation inside a claim: the artifact plus what was read from it. */
export const evidenceItem = artifactRef.extend({
  quote: z.string().max(2000).optional(),
  observedAt: z.iso.datetime({ offset: true }).optional(),
});
export type EvidenceItem = z.infer<typeof evidenceItem>;

export const evidenceLimit = 32;
export const evidenceList = z.array(evidenceItem).max(evidenceLimit);

/**
 * Key for deduplicating repeated citations of the same artifact version.
 * Different hashes or versions of one record stay distinct.
 */
export const evidenceKey = (item: ArtifactRef) =>
  JSON.stringify([
    item.provider,
    item.recordId,
    item.version ?? null,
    item.contentHash ?? null,
  ]);

/** True when a cited artifact has a different version than the one cited. */
export const changedSinceCited = (
  cited: Pick<ArtifactRef, "version">,
  current: Pick<ArtifactRef, "version">,
) =>
  cited.version !== undefined &&
  current.version !== undefined &&
  cited.version !== current.version;
