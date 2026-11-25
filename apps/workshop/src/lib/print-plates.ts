import { z } from "zod";

export const printDigest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().trim().min(1).max(160);
const receipt = z.object({
  fileName: z.string().max(160).regex(/^[a-z0-9_][a-z0-9_.-]*$/i),
  sha256: printDigest,
  bytes: z.number().int().positive().max(25 * 1024 * 1024),
}).strict();
const member = z.object({itemId:z.uuid(),sha256:printDigest,quantity:z.number().int().min(1).max(1000)}).strict();
const plate = z.object({index:z.number().int().min(1).max(50),name,members:z.array(member).min(1).max(100)}).strict();
export const PrintPlateInput = z.object({
  projectId:z.uuid(),expectedRevision:z.number().int().nonnegative(),slicer:name,
  artifact:receipt.refine(value=>value.fileName.toLowerCase().endsWith(".3mf")),
  result:receipt.refine(value=>value.fileName.toLowerCase().endsWith(".json") && value.bytes <= 2_000_000),
  plates:z.array(plate).min(1).max(30),
}).strict();

export const PrintPackageSchema = PrintPlateInput.omit({projectId:true,expectedRevision:true}).extend({
  sourceRevision:z.number().int().nonnegative(),
  recordedAt:z.string(),
  recordedBy:z.string(),
  geometryVerified:z.literal(true).optional(),
  printer:name,material:name,profileSha256:printDigest,
  plates:z.array(plate.extend({
    durationSeconds:z.number().positive(),filamentGrams:z.number().nonnegative(),
    warnings:z.array(z.string().max(2000)).max(30),
  })).min(1).max(30),
});
