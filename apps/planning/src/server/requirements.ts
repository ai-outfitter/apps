// Planning-owned project requirements (docs/plans/project-delivery-flow.md). A requirement has a
// stable caller key, a server id and revisions. The action digest covers only what a requirement
// asks for, so a title, notes or formatting edit is a new revision that starts no preparation.
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";

const line = (max = 2000) => z.string().trim().min(1).max(max);
const list = <T extends z.ZodType>(item: T, max = 32) => z.array(item).max(max).default([]);

export const requirementKinds = ["research", "hardware", "enclosure", "wiring", "mechanical", "firmware", "software", "marketing", "manufacturing"] as const;
/** Kinds whose work goes to Workshop or to Foundry. */
export const hardwareKinds: readonly string[] = ["hardware", "enclosure", "wiring", "mechanical"];
export const softwareKinds: readonly string[] = ["firmware", "software"];

const dimension = z.strictObject({
  name: line(120),
  /** Millimetres; null while unknown. Never guessed. */
  value: z.number().positive().max(100000).nullable().default(null),
  verified: z.boolean().default(false),
});
export const requirementInput = z.strictObject({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "Use a short slug such as i2c-bus").describe("Stable key you choose; the same key later revises this requirement."),
  title: line(200),
  kind: z.enum(requirementKinds).optional().describe("Routes the work: hardware, enclosure, wiring and mechanical go to Workshop; firmware and software to Foundry; research needs clarification first. Omit to let the Planning router decide."),
  statement: line(4000),
  acceptanceCriteria: list(line(), 20).describe("Observable results that accept the requirement. None makes a focused question."),
  constraints: list(line()),
  /** Named shared values (pins, addresses, buses). The same name with different values is a conflict. */
  interfaces: list(z.strictObject({ name: line(120), value: line(200) })),
  /** Parts the requirement needs; cost, source and inventory are unknown unless given. */
  components: list(z.strictObject({
    name: line(150),
    kind: z.enum(["cots", "printed", "pcb", "assembly"]).default("cots"),
    manufacturer: z.string().trim().max(100).optional(),
    mpn: z.string().trim().max(100).optional(),
    quantity: z.number().int().min(1).max(1000).default(1),
    unitCost: z.number().min(0).max(100000).nullable().default(null),
  })),
  connections: list(z.strictObject({ from: line(150), to: line(150), signal: line(120) }), 64),
  dimensions: list(dimension, 16),
  deliverables: list(line(300), 20).describe("Files or outputs, such as esphome/sny-1-breadboard.yaml."),
  /** Keys of requirements this one cannot be satisfied before. */
  dependsOn: list(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), 16),
  unknowns: list(line(), 16).describe("What is not known yet; each becomes a question, never an invented value."),
  assumptions: list(line(), 16),
  target: z.strictObject({
    repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/).optional(),
    productRevision: z.string().trim().max(200).optional(),
    productRevisionId: z.uuid().optional(),
  }).default({}),
  notes: z.string().trim().max(4000).default(""),
});
export type RequirementInput = z.output<typeof requirementInput>;
export const requirementList = z.array(requirementInput).max(100).superRefine((items, ctx) => {
  if (new Set(items.map((item) => item.key)).size !== items.length) ctx.addIssue({ code: "custom", message: "Each requirement key may appear once." });
});
export const retireList = z.array(requirementInput.shape.key).max(100);

/** Lowercased, whitespace-collapsed and Markdown-emphasis-stripped, so reflowing a sentence is not a change. */
const normal = (value: string) => value.replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim().toLowerCase();
export function actionableContent(value: RequirementInput) {
  const n = (items: string[]) => items.map(normal);
  return {
    kind: value.kind ?? null,
    statement: normal(value.statement),
    acceptanceCriteria: n(value.acceptanceCriteria),
    constraints: n(value.constraints),
    interfaces: value.interfaces.map((i) => [normal(i.name), normal(i.value)]),
    components: value.components.map((c) => ({ ...c, name: normal(c.name) })),
    connections: value.connections.map((c) => [normal(c.from), normal(c.to), normal(c.signal)]),
    dimensions: value.dimensions.map((d) => ({ ...d, name: normal(d.name) })),
    deliverables: n(value.deliverables),
    dependsOn: [...value.dependsOn].sort(),
    unknowns: n(value.unknowns),
    target: value.target,
  };
}
export const actionDigest = async (value: RequirementInput) => sha256Hex(canonicalActionValue(actionableContent(value)));
export const retiredDigest = "retired";

export type StoredRequirement = { id: string; key: string; revision: number; retired: boolean; body: RequirementInput; actionDigest: string };
export type RequirementChange = { key: string; id: string; revision: number; change: "added" | "changed" | "descriptive" | "retired" | "unchanged"; actionable: boolean };

/** One requirement's write and change for a saved body. */
async function planUpsert(prior: StoredRequirement | undefined, body: RequirementInput): Promise<{ write: { row: StoredRequirement; insert: boolean } | null; change: RequirementChange }> {
  const digest = await actionDigest(body);
  if (!prior) {
    const row = { id: crypto.randomUUID(), key: body.key, revision: 1, retired: false, body, actionDigest: digest };
    return { write: { row, insert: true }, change: { key: body.key, id: row.id, revision: 1, change: "added", actionable: true } };
  }
  if (!prior.retired && canonicalActionValue(prior.body) === canonicalActionValue(body))
    return { write: null, change: { key: body.key, id: prior.id, revision: prior.revision, change: "unchanged", actionable: false } };
  const actionable = prior.retired || prior.actionDigest !== digest;
  const row = { ...prior, revision: prior.revision + 1, retired: false, body, actionDigest: digest };
  return { write: { row, insert: false }, change: { key: body.key, id: row.id, revision: row.revision, change: actionable ? "changed" : "descriptive", actionable } };
}

/** What saving `upserts` and retiring `retire` would do to `current`, with each written row. */
export async function planRequirementChanges(current: StoredRequirement[], upserts: RequirementInput[], retire: string[]) {
  const byKey = new Map(current.map((row) => [row.key, row]));
  for (const key of retire) {
    if (!byKey.get(key)) throw new Response(`No requirement ${key} to retire`, { status: 409 });
    if (upserts.some((item) => item.key === key)) throw new Response(`Requirement ${key} cannot be revised and retired together`, { status: 409 });
  }
  const writes: { row: StoredRequirement; insert: boolean }[] = [];
  const changes: RequirementChange[] = [];
  for (const body of upserts) {
    const planned = await planUpsert(byKey.get(body.key), body);
    if (planned.write) writes.push(planned.write);
    changes.push(planned.change);
  }
  for (const key of retire) {
    const prior = byKey.get(key)!;
    if (prior.retired) { changes.push({ key, id: prior.id, revision: prior.revision, change: "unchanged", actionable: false }); continue; }
    const row = { ...prior, revision: prior.revision + 1, retired: true };
    writes.push({ row, insert: false });
    changes.push({ key, id: row.id, revision: row.revision, change: "retired", actionable: true });
  }
  return { writes, changes };
}
