import { z } from "zod";
import { assertionBody, ontologyContract } from "@ai-outfitter/app-sdk/wiki";

const subjectRecord = z.object({ id: z.uuid(), typeId: z.uuid(), title: z.string() }).catchall(z.json());
export const subjectSnapshot = z.strictObject({
  record: subjectRecord,
  links: z.array(z.object({ id: z.uuid(), typeId: z.uuid(), fromId: z.uuid(), toId: z.uuid() }).catchall(z.json())),
  participants: z.array(subjectRecord),
  types: z.array(z.object({ id: z.uuid(), title: z.string(), ontology: ontologyContract.optional() }).catchall(z.json())),
});
const receipt = z.strictObject({
  assertionId: z.uuid(),
  assertionRevision: z.number().int().positive(),
  userId: z.string(),
  assertionBody,
  subjectSnapshot,
  assertionHash: z.string(),
  subjectHash: z.string(),
  confirmedAt: z.iso.datetime(),
});
export const assertionInspection = z.strictObject({
  subjectSnapshot,
  id: z.uuid(),
  revision: z.number().int().positive(),
  assertion: assertionBody,
  subjectCurrent: z.boolean(),
  subjectHash: z.string(),
  confirmed: z.boolean(),
  confirmations: z.array(receipt).max(100),
  historyTruncated: z.boolean(),
});
export const assertionInspectInput = z.strictObject({
  id: z.uuid(),
  includeHistory: z.boolean().default(false),
});
export const assertionConfirmInput = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  affirm: z.literal(true),
  subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type AssertionInspection = z.infer<typeof assertionInspection>;
