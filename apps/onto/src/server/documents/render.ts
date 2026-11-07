import type { Capture, DocumentContract } from "./service";

/** Deliberately small schema subset; unsupported keywords fail closed. */
export function validateSchema(
  schema: Record<string, unknown>,
  value: unknown,
  depth = 0,
): boolean {
  if (
    depth > 8 ||
    Object.keys(schema).some(
      (k) =>
        ![
          "type",
          "properties",
          "required",
          "items",
          "additionalProperties",
          "enum",
        ].includes(k),
    )
  )
    return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
  )
    return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const obj = value as Record<string, unknown>,
      props = schema.properties;
    if (
      props !== undefined &&
      (!props || typeof props !== "object" || Array.isArray(props))
    )
      return false;
    const properties = (props ?? {}) as Record<string, Record<string, unknown>>;
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((k) => typeof k !== "string" || !(k in obj)))
    )
      return false;
    if (
      schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false
    )
      return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(obj).some((k) => !(k in properties))
    )
      return false;
    return Object.entries(properties).every(
      ([k, s]) =>
        !(k in obj) ||
        (!!s && typeof s === "object" && validateSchema(s, obj[k], depth + 1)),
    );
  }
  if (schema.type === "array")
    return (
      Array.isArray(value) &&
      !!schema.items &&
      typeof schema.items === "object" &&
      value.every((v) =>
        validateSchema(schema.items as Record<string, unknown>, v, depth + 1),
      )
    );
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "integer")
    return typeof value === "number" && Number.isSafeInteger(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "null") return value === null;
  return false;
}
export const defaultContract: DocumentContract = {
  version: 1,
  identity: "evidence",
  inputSchema: { type: "object" },
  outputSchema: {
    type: "object",
    required: ["title", "markdown"],
    properties: { title: { type: "string" }, markdown: { type: "string" } },
    additionalProperties: false,
  },
  params: {},
  rendering: { mode: "template", template: "evidence" },
  refresh: "manual",
  requirements: { evidence: true, seal: false, export: false },
};
/** Bounded JSON Pointer lookup; no expressions or executable templates. */
function selected(snapshot: unknown, pointer: string): unknown {
  if (pointer === "") return snapshot;
  if (!pointer.startsWith("/") || pointer.length > 512) return undefined;
  let value: unknown = snapshot;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      ["__proto__", "prototype", "constructor"].includes(key) ||
      !value ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function markdown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((v) => `- ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
  return JSON.stringify(value, null, 2);
}
/** Definitions own their section semantics; Onto only selects captured values. */
export function renderTemplate(contract: DocumentContract, capture: Capture) {
  const labels = {
    evidence: "Evidence",
    "business-review": "Business review",
    roadmap: "Roadmap",
    "feature-issue": "Feature issue draft",
    "bug-issue": "Bug issue draft",
  };
  const title = contract.rendering.title ?? labels[contract.rendering.template];
  const missing: string[] = [];
  const sections = contract.rendering.sections?.map((section) => {
    const sources = capture.sources.filter(
      (s) => s.provider === section.provider,
    );
    const value =
      sources.length === 1
        ? selected(sources[0].snapshot, section.pointer)
        : undefined;
    const absent =
      value === undefined ||
      value === null ||
      (Array.isArray(value) && !value.length) ||
      value === "";
    if (absent && section.required) missing.push(section.title);
    return `## ${section.title}\n\n${absent ? "Missing context: this selection supplied no records." : markdown(value)}`;
  });
  const lines =
    sections ??
    capture.sources.map(
      (s) => `- ${s.provider}: ${JSON.stringify(s.snapshot)}`,
    );
  const gaps = missing.length
    ? `\n\n## Missing required context\n\n${missing.map((v) => `- ${v}`).join("\n")}`
    : "";
  const stub = contract.rendering.template.endsWith("-issue")
    ? "\n\nPublication: STUB — no issue was published."
    : "";
  return {
    title,
    markdown: `# ${title}\n\n${lines.join("\n\n")}${gaps}${stub}`,
  };
}
