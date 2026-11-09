/** Strict structured output requires closed objects with every field required.
 * Keep the existing non-strict path for schemas with optional fields or maps.
 * Validation against the app's schema still runs in either mode.
 */
export function strictStructuredResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  // These constructs are outside the provider's strict schema subset.
  if (
    [
      "not",
      "allOf",
      "oneOf",
      "if",
      "then",
      "else",
      "patternProperties",
      "propertyNames",
    ].some((key) => key in schema)
  )
    return false;
  if (schema.type === "object" && !closedRequiredObject(schema)) return false;
  if (schema.type === "array" && !strictStructuredResult(schema.items))
    return false;
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  const definitions = ["$defs", "definitions"].flatMap((key) =>
    Object.values(schema[key] ?? {}),
  );
  return [...alternatives, ...definitions].every(strictStructuredResult);
}

function closedRequiredObject(schema: Record<string, unknown>): boolean {
  if (schema.additionalProperties !== false) return false;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return (
    Object.keys(properties).every((key) => required.includes(key)) &&
    Object.values(properties).every(strictStructuredResult)
  );
}
