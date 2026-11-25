import { z } from "zod";
import { assemblyFile } from "./assembly-file";

const text = z.string().trim().min(1).max(500);
const revision = z.int().positive();
const digest = assemblyFile.shape.sha256;
const configurationName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const photoDigests = z.array(digest).max(12);
export const cotsEvidenceRef = z.strictObject({
  projectId: z.uuid(), itemId: z.uuid(), revision: revision.optional(),
});
const tolerance = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unknown") }),
  z.strictObject({ kind: z.literal("specified"), minus: z.number().nonnegative(), plus: z.number().nonnegative() }),
]);
const trial = z.strictObject({
  trialId: z.uuid(), testedProjectId: z.uuid(), testedRevision: revision,
  testedConfiguration: configurationName.optional(),
  testedParameters: z.record(configurationName, z.number()).optional(),
});
const verification = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("untested"), reason: text.optional(), trial: trial.optional() }),
  trial.extend({
    status: z.enum(["fits", "interferes"]), testedOwnerRevision: revision.optional(),
    observation: text, photoSha256s: photoDigests.min(1),
  }),
]);
const dimension = z.strictObject({
  id: z.uuid(), feature: text, datum: text, axis: text, unit: z.enum(["mm", "in", "deg"]),
  nominal: z.strictObject({ value: z.number(), basis: z.enum(["supplier", "design"]), source: text }).optional(),
  measured: z.strictObject({ value: z.number(), basis: z.literal("owned-part"), source: text }).optional(),
  tolerance, photoSha256s: photoDigests, verification,
});
export const cotsEvidence = z.strictObject({
  photos: z.array(z.strictObject({
    fileName: assemblyFile.shape.fileName, sha256: digest, attachmentRevision: revision, observation: text,
    attachmentOwner: z.strictObject({ projectId: z.uuid(), itemId: z.uuid() }).optional(),
  })).max(24),
  interfaces: z.array(dimension).max(40),
}).superRefine(({ photos, interfaces }, ctx) => {
  const known = new Set(photos.map(photo => photo.sha256));
  const attachments = new Set(photos.map(photo => JSON.stringify([
    photo.sha256, photo.attachmentOwner?.projectId, photo.attachmentOwner?.itemId, photo.attachmentRevision, photo.fileName,
  ])));
  if (attachments.size !== photos.length) ctx.addIssue({ code: "custom", path: ["photos"], message: "Each photo attachment appears once" });
  const ids = new Set<string>();
  for (const [index, item] of interfaces.entries()) {
    const fail = (field: string, message: string) => ctx.addIssue({ code: "custom", path: ["interfaces", index, field], message });
    if (ids.has(item.id)) fail("id", "Each interface ID appears once");
    ids.add(item.id);
    if (item.measured && !item.photoSha256s.length) fail("photoSha256s", "Measured values require a reference photo");
    const digests = [...item.photoSha256s, ...(item.verification.status === "untested" ? [] : item.verification.photoSha256s)];
    if (digests.some(sha => !known.has(sha))) fail("photoSha256s", "Use a recorded photo digest");
  }
});
export type CotsEvidence = z.infer<typeof cotsEvidence>;
export type CotsEvidenceRef = z.infer<typeof cotsEvidenceRef>;
