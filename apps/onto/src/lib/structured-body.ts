export type BodySchema = Record<string, unknown>;
const asSchema = (value: unknown): BodySchema =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as BodySchema)
    : {};
const label = (key: string) =>
  key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const heading = (text: string) =>
  text.replace(/[\r\n]/g, " ").replace(/([\\`*_{}[\]<>()#!|])/g, "\\$1");
const level = (depth: number) => "#".repeat(Math.min(depth + 2, 6));

function reference(root: BodySchema, input: BodySchema): BodySchema {
  if (typeof input.$ref !== "string" || !input.$ref.startsWith("#/"))
    return input;
  let target: unknown = root;
  for (const part of input.$ref.slice(2).split("/"))
    target = asSchema(target)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
  return { ...asSchema(target), ...input };
}
function resolved(
  root: BodySchema,
  input: BodySchema,
  value: unknown,
): BodySchema {
  const field = reference(root, input);
  const variants = field.anyOf ?? field.oneOf;
  if (!Array.isArray(variants)) return field;
  const kind =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const selected = variants.find((variant) => asSchema(variant).type === kind);
  return { ...field, ...asSchema(selected) };
}

/** Domain meaning and field help come from the type schema; authored values stay unchanged. */
export function structuredBodyMarkdown(
  body: string,
  schema?: BodySchema,
): string | null {
  if (!schema) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const root = schema;
  function fieldSection(
    key: string,
    item: unknown,
    input: BodySchema,
    depth: number,
  ): string {
    const field = resolved(root, input, item);
    const title = typeof field.title === "string" ? field.title : label(key);
    const help =
      typeof field.description === "string"
        ? `> ${field.description.replaceAll("\n", "\n> ")}\n\n`
        : "";
    return `${level(depth)} ${heading(title)}\n\n${help}${render(item, field, depth + 1)}\n`;
  }
  function objectSection(
    item: BodySchema,
    field: BodySchema,
    depth: number,
  ): string {
    const fields = asSchema(field.properties);
    const keys = [
      ...new Set([...Object.keys(fields), ...Object.keys(item)]),
    ].filter((key) => Object.hasOwn(item, key));
    if (!keys.length) return "*None recorded.*\n";
    return keys
      .map((key) => fieldSection(key, item[key], asSchema(fields[key]), depth))
      .join("\n");
  }
  function arraySection(
    items: unknown[],
    field: BodySchema,
    depth: number,
  ): string {
    if (!items.length) return "*None recorded.*\n";
    return items
      .map((item, index) => {
        const text = render(item, asSchema(field.items), depth + 1);
        return item !== null && typeof item === "object"
          ? `${level(depth)} Item ${index + 1}\n\n${text}`
          : `- ${text.trim().replaceAll("\n", "\n  ")}\n`;
      })
      .join("\n");
  }
  function render(item: unknown, input: BodySchema, depth: number): string {
    const field = resolved(root, input, item);
    if (depth > 10)
      return `\n\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\`\n`;
    if (item === null || item === "") return "*Not specified.*\n";
    if (Array.isArray(item)) return arraySection(item, field, depth);
    if (typeof item === "object")
      return objectSection(asSchema(item), field, depth);
    if (typeof item === "boolean") return item ? "Yes\n" : "No\n";
    return `${String(item)}\n`;
  }
  return render(value, root, 0);
}
