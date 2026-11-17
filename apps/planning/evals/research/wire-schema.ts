import { z } from "zod";
import { answerSchema } from "./grade";
/** OpenAI structured outputs do not support JSON Schema's uri format.
 * Remove only that wire hint; the production Zod validator still checks URLs. */
export function wireSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(answerSchema);
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const object = value as Record<string, unknown>;
    if (object.format === "uri") delete object.format;
    Object.values(object).forEach(visit);
  }
  visit(schema);
  return schema;
}
