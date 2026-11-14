import { z } from "zod";
import { artifactRef } from "@ai-outfitter/app-sdk/evidence";
import { entityRef } from "@ai-outfitter/app-sdk/entities";
export const pinned = entityRef.extend({
  revision: z.number().int().positive(),
});
export const artifact = artifactRef.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const fragment = z.strictObject({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  text: z.string().max(64000),
  references: z.array(z.string()).max(64).default([]),
  record: pinned.optional(),
  sourcePath: z.string().optional(),
});
export const recipe = z.strictObject({
  root: z.string(),
  fragments: z.array(fragment).max(256),
  inputs: z.array(artifact).max(64).default([]),
  settings: z.record(z.string(), z.json()).default({}),
});
export type Recipe = z.infer<typeof recipe>;
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
/** Pure dependency traversal; adapters supply authorized, revision-pinned records. */
export async function freeze(raw: unknown) {
  const input = recipe.parse(raw),
    byId = new Map(input.fragments.map((f) => [f.id, f]));
  if (byId.size !== input.fragments.length)
    throw Error("Duplicate fragment ID");
  const visited = new Set<string>(),
    active: string[] = [],
    ordered: z.infer<typeof fragment>[] = [];
  function visit(id: string) {
    if (active.includes(id))
      throw Error(`Prompt cycle: ${[...active, id].join(" → ")}`);
    if (visited.has(id)) return;
    const f = byId.get(id);
    if (!f) throw Error(`Missing prompt fragment: ${id}`);
    active.push(id);
    for (const child of f.references) visit(child);
    active.pop();
    visited.add(id);
    ordered.push(f);
  }
  visit(input.root);
  const layers = await Promise.all(
    ordered.map(async (f) => ({
      id: f.id,
      revision: f.revision,
      hash: await digest(canonical(f)),
      ...(f.record ? { record: f.record } : {}),
    })),
  );
  const manifest = {
    resolver: "creative-workflow/1" as const,
    root: input.root,
    text: ordered.map((f) => f.text.trim()).join("\n\n\n"),
    layers,
    inputs: input.inputs,
    settings: input.settings,
  };
  return { ...manifest, hash: await digest(canonical(manifest)) };
}
export type Snapshot = Awaited<ReturnType<typeof freeze>>;
export function drift(
  previous: Snapshot | null | undefined,
  current: Snapshot,
) {
  if (!previous) return { state: "unknown" as const, changed: [] as string[] };
  const before = new Map(previous.layers.map((l) => [l.id, l.hash])),
    after = new Map(current.layers.map((l) => [l.id, l.hash]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => before.get(id) !== after.get(id),
  );
  if (canonical(previous.inputs) !== canonical(current.inputs))
    changed.push("reference artifacts");
  if (canonical(previous.settings) !== canonical(current.settings))
    changed.push("generation settings");
  if (previous.resolver !== current.resolver) changed.push("resolver");
  return {
    state:
      previous.hash === current.hash
        ? ("current" as const)
        : ("stale" as const),
    changed,
  };
}
export const selection = z.strictObject({
  use: pinned,
  slot: z.string().min(1).max(200),
  candidate: pinned,
});
export function selectedCandidate<T extends { id: string }>(
  candidates: T[],
  selectedId: string | null,
) {
  return selectedId
    ? (candidates.find((c) => c.id === selectedId) ?? null)
    : null;
}
export const kinds = [
  "CreativeBrief",
  "PromptFragment",
  "Storyboard",
  "GenerationSnapshot",
  "CreativeCandidate",
  "CreativeSelection",
  "CreativeFeedback",
] as const;
export type CreativeKind = (typeof kinds)[number];
export const typeIds = Object.fromEntries(
  kinds.map((kind, i) => [
    kind,
    `bce00000-0000-4000-8000-${String(kind === "CreativeFeedback" ? 8 : i + 1).padStart(12, "0")}`,
  ]),
) as Record<CreativeKind, string>;
export const brief = z.strictObject({
  subject: pinned,
  purpose: z.string().min(1),
  audience: z.string(),
  constraints: z.array(z.string()).default([]),
  references: z.array(artifactRef).default([]),
});
export const storyboard = z.strictObject({
  brief: pinned,
  items: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        narrative: z.string(),
        prompt: pinned.optional(),
        references: z.array(artifactRef).default([]),
      }),
    )
    .min(1)
    .max(100),
});
export const candidate = z.strictObject({
  subject: pinned,
  snapshot: pinned.optional(),
  artifact: artifactRef,
  mediaType: z
    .enum([
      "image/png",
      "image/jpeg",
      "video/mp4",
      "application/pdf",
      "model/gltf-binary",
      "application/zip",
    ])
    .optional(),
  owner: entityRef,
  ownerRevision: z.number().int().positive().optional(),
  concept: z.boolean(),
  feedback: z
    .array(
      z.strictObject({ at: z.string(), author: z.string(), text: z.string() }),
    )
    .default([]),
  sourcePath: z.string().optional(),
  sourceRecord: z.json().optional(),
});
export const handoff = z.strictObject({
  selection: pinned,
  purpose: z.string().min(1),
  dimensions: z.string().default("Unknown"),
  materials: z.string().default("Unknown"),
  interfaces: z.string().default("Unknown"),
  questions: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).min(1),
});

export const frozenSnapshot = z.strictObject({
  resolver: z.literal("creative-workflow/1"),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string(),
  root: z.string(),
  layers: z.array(
    z.strictObject({
      id: z.string(),
      revision: z.number().int().positive(),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      record: pinned.optional(),
    }),
  ),
  inputs: z.array(artifact),
  settings: z.record(z.string(), z.json()),
});
export const legacySnapshot = z.strictObject({
  resolver: z.literal("artera/legacy"),
  hash: z.string().regex(/^[a-f0-9]{16}$/),
  text: z.string(),
  sourcePath: z.string(),
  manifest: z.record(z.string(), z.json()),
});
export const generationSnapshot = z.discriminatedUnion("resolver", [
  frozenSnapshot,
  legacySnapshot,
]);

export const feedback = z.strictObject({
  candidate: pinned,
  at: z.string().min(1),
  author: z.string().min(1),
  text: z.string().min(1).max(10000),
});
