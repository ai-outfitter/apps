import { z } from "zod";

export const ontologyViolation = z.strictObject({
  recordId: z.string(),
  rule: z.string(),
  path: z.string(),
  message: z.string(),
  relatedRecordIds: z.array(z.string()).optional(),
});
export type OntologyViolation = z.infer<typeof ontologyViolation>;
