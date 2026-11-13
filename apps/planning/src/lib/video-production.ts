import { z } from "zod";
import { artifactRef } from "@ai-outfitter/app-sdk/evidence";
import { entityRef } from "@ai-outfitter/app-sdk/entities";
export const pinnedEntity = entityRef.extend({
  revision: z.number().int().positive(),
});
export const videoSource = z.strictObject({
  kind: z.enum([
    "concept",
    "screenshot",
    "screen-recording",
    "render",
    "photo",
  ]),
  label: z.string().min(1).max(200),
  artifact: artifactRef,
  record: pinnedEntity.optional(),
  assetId: z.uuid().optional(),
});
export const videoShot = z.strictObject({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  duration: z.number().int().min(2).max(30),
  narration: z.string().max(2000).default(""),
  prompt: z.string().min(1).max(4000),
  source: videoSource.optional(),
});
export const videoPacket = z
  .strictObject({
    product: pinnedEntity,
    productRevision: pinnedEntity.optional(),
    title: z.string().min(1).max(200),
    audience: z.string().min(1).max(2000),
    message: z.string().min(1).max(4000),
    channel: z.enum(["instagram", "facebook", "x", "tiktok", "internal"]),
    style: z.string().max(4000),
    concept: z.boolean(),
    shots: z.array(videoShot).min(1).max(30),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.shots.map((s) => s.id)).size !== value.shots.length)
      ctx.addIssue({
        code: "custom",
        message: "Shot IDs must be unique",
        path: ["shots"],
      });
    if (!value.concept && value.shots.some((s) => s.source?.kind === "concept"))
      ctx.addIssue({
        code: "custom",
        message: "Concept sources require a concept production",
        path: ["concept"],
      });
  });
export type VideoPacket = z.infer<typeof videoPacket>;
export const saveVideoInput = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  packet: videoPacket,
});
export const videoReadInput = z.strictObject({
  id: z.uuid().optional(),
  productId: z.uuid().optional(),
  revision: z.number().int().positive().optional(),
  after: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const videoTakeInput = z.strictObject({
  id: z.uuid(),
  productionId: z.uuid(),
  revision: z.number().int().positive(),
  shotId: z.uuid(),
  seed: z.number().int().min(0).max(2147483647).default(20261105),
});
export const takeUpdateInput = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  state: z.enum([
    "submitting",
    "submitted",
    "completed",
    "failed",
    "uncertain",
  ]),
  providerRequestId: z.string().min(1).max(200).optional(),
  error: z.string().max(2000).optional(),
  assetId: z.uuid().optional(),
});
export const videoAssetInput = z.strictObject({
  transport: z.enum(["direct", "http"]).default("direct"),
  productionId: z.uuid(),
  id: z.uuid(),
  kind: z.enum(["frame", "take", "final", "manifest"]),
  filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/),
  contentType: z.enum([
    "video/mp4",
    "image/png",
    "image/jpeg",
    "application/json",
  ]),
  size: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  productionRevision: z.number().int().positive(),
});
export const assetCommitInput = z.strictObject({
  productionId: z.uuid(),
  id: z.uuid(),
});
export const publishVideoInput = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
});
export function downloadName(title: string, revision: number) {
  return `${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 90) || "video"
  }-v${revision}.mp4`;
}
