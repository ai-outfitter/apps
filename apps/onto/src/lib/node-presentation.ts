import { z } from "zod";
import type { GraphNode, TypeDefinition } from "./graph";

const field = z.object({
  label: z.string().max(120),
  path: z.string().max(200).optional(),
  property: z.string().max(80).optional(),
  suffixProperty: z.string().max(80).optional(),
  format: z.enum(["text", "table", "expression", "decision"]).default("text"),
  description: z.string().max(500).optional(),
});
export const presentationSchema = z.object({
  version: z.literal(1),
  entityLabel: z.string().max(80).optional(),
  summaryPath: z.string().max(200).optional(),
  tabs: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .max(40),
        label: z.string().max(60),
        sections: z
          .array(
            z.object({
              title: z.string().max(120),
              fields: z.array(field).max(20),
            }),
          )
          .max(12),
      }),
    )
    .max(4)
    .refine(
      (tabs) =>
        new Set(tabs.map((tab) => tab.id)).size === tabs.length &&
        tabs.every((tab) => tab.id !== "technical"),
      "Use unique tab IDs; technical is provided by the reader",
    ),
  inputLabels: z.record(z.string(), z.string().max(100)).default({}),
});
export type Presentation = z.infer<typeof presentationSchema>;
export type PresentationField = z.infer<typeof field>;
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const humanize = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
export function bodyObject(node: Pick<GraphNode, "body">) {
  try {
    return JSON.parse(node.body) as unknown;
  } catch {
    return undefined;
  }
}
export function presentation(type?: Pick<TypeDefinition, "jsonSchema">) {
  const result = presentationSchema.safeParse(
    type?.jsonSchema?.["x-wiki-presentation"],
  );
  return result.success ? result.data : undefined;
}
/** Own properties only: schema paths never traverse object prototypes. */
export function atPath(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current = value;
  for (const segment of path.split(".")) {
    if (!Object.hasOwn(object(current), segment)) return undefined;
    current = object(current)[segment];
  }
  return current;
}
export function fieldValue(
  node: Pick<GraphNode, "body" | "properties">,
  field: PresentationField,
) {
  const value = field.property
    ? node.properties[field.property]
    : atPath(bodyObject(node), field.path);
  const suffix = field.suffixProperty
    ? node.properties[field.suffixProperty]
    : undefined;
  return suffix && value !== undefined ? `${value} ${suffix}` : value;
}
export function summary(
  node: Pick<GraphNode, "summary" | "body">,
  view?: Presentation,
) {
  if (node.summary?.trim()) return node.summary.trim();
  const body = bodyObject(node);
  const text = atPath(body, view?.summaryPath) ?? object(body).description;
  if (typeof text === "string") return text;
  if (body !== undefined) return "";
  return node.body
    .split(/\n\s*\n/)[0]
    .replace(/^#+\s*/, " ")
    .trim();
}

type Expression = { name: string; operator: string; arguments: unknown[] };
export type ReadableProgram = {
  expression: string;
  decisions: { condition: string; result: string }[];
};
const symbols: Record<string, string> = {
  add: "+",
  subtract: "−",
  multiply: "×",
  divide: "÷",
  eq: "=",
  lt: "<",
  lte: "≤",
  gte: "≥",
  and: "and",
  or: "or",
};
function argument(
  arg: unknown,
  steps: Map<string, string>,
  labels: Record<string, string>,
): string {
  const a = object(arg);
  if (typeof a.input === "string") return labels[a.input] ?? humanize(a.input);
  if (typeof a.step === "string")
    return steps.get(a.step) ?? `[Unknown step: ${a.step}]`;
  if (a.value === null) return "null";
  if (typeof a.value === "boolean") return a.value ? "yes" : "no";
  return typeof a.value === "string"
    ? humanize(a.value)
    : String(a.value ?? "?");
}
function expression(op: string, args: string[]) {
  if (Object.hasOwn(symbols, op)) return `(${args.join(` ${symbols[op]} `)})`;
  if (op === "identity") return args[0] ?? "?";
  if (op === "is_null") return `${args[0]} is missing`;
  if (op === "is_not_null") return `${args[0]} is present`;
  if (op === "count_distinct")
    return `Distinct count of ${args[0]} where ${args[1]}`;
  return `${humanize(op)}(${args.join(", ")})`;
}
/** A readable rendering of stored operators, not a compiler or evaluator. */
export function readableProgram(
  value: unknown,
  labels: Record<string, string> = {},
): ReadableProgram {
  if (!Array.isArray(value))
    return { expression: "No operator program recorded", decisions: [] };
  const steps = new Map<string, string>();
  let decisions: ReadableProgram["decisions"] = [],
    last = "";
  for (const raw of value.slice(0, 128)) {
    const step = object(raw) as unknown as Expression;
    if (
      typeof step.name !== "string" ||
      typeof step.operator !== "string" ||
      !Array.isArray(step.arguments)
    )
      continue;
    const args = step.arguments.map((arg) => argument(arg, steps, labels));
    if (step.operator === "case") decisions = decisionRows(args);
    last =
      step.operator === "case"
        ? "Decision table"
        : expression(step.operator, args);
    if (last.length > 12000)
      return {
        expression:
          "Expression too large to display; inspect the specification.",
        decisions: [],
      };
    steps.set(step.name, last);
  }
  return { expression: last, decisions };
}
function decisionRows(args: string[]) {
  const rows = [];
  for (let i = 0; i < args.length - 1; i += 2)
    rows.push({ condition: args[i], result: args[i + 1] });
  if (args.length % 2)
    rows.push({ condition: "Otherwise", result: args[args.length - 1] });
  return rows;
}
