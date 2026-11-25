import { z } from "zod";

const passageLength = 1200;
const maxPassages = 10_000;
const sourceId = z.string().min(1).max(600);
const version = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePin = z.strictObject({ sourceId, version });
const owner = z.object({ organizationId: z.string(), installationId: z.string() });
const wikiSource = sourcePin.extend({
  ...owner.shape,
  pageId: z.string(), pageSlug: z.string(), pageRevision: z.number().int().positive(),
  documentId: z.string().nullable(), revision: z.number().int().positive().nullable(),
  sha256: version.nullable(), contentHash: version.nullish(), fileName: z.string().nullable(),
});
const offsets = { start: z.number().int().nonnegative(), end: z.number().int().positive() };
const locator = z.discriminatedUnion("kind", [
  z.object({ ...offsets, kind: z.literal("wiki-page"), section: z.enum(["title", "summary", "body", "generatedBody"]) }),
  z.object({ ...offsets, kind: z.literal("pdf-page"), page: z.number().int().positive() }),
  z.object({ ...offsets, kind: z.literal("transcript"), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() }),
]);
const extractedPassage = z.object({ text: z.string().min(1).max(passageLength), locator });
const sourceInventory = owner.extend({ sources: z.array(wikiSource).max(100), next: sourceId.nullable() });
const sourceRead = z.discriminatedUnion("state", [
  z.object({ state: z.literal("changed") }),
  z.object({ state: z.literal("active"), source: wikiSource.extend({ contentHash: version }), passages: z.array(extractedPassage).max(maxPassages), issue: z.string().max(300).nullable() }),
]);
const verification = owner.extend({ active: z.array(sourceId) });

export const wikiPassage = { sourceId, sourcePin, owner, wikiSource, locator, sourceInventory, sourceRead, verification, passageLength, maxPassages };
