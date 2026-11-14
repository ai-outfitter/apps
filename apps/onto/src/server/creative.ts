import { z } from "zod";
import { verifyLegacySnapshot } from "@ai-outfitter/creative-workflow/artera";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import { GraphQLString, GraphQLInt } from "graphql";
import { JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import { mutationField } from "@ai-outfitter/app-sdk/app-graphql";
import {
  feedback,
  generationSnapshot,
  freeze,
  digest,
  canonical,
  drift,
  brief,
  fragment,
  storyboard,
  candidate,
  selection,
  typeIds,
  kinds,
  artifact,
  type CreativeKind,
} from "@ai-outfitter/creative-workflow";
import { readGraph } from "./graph";
import { addressIndex, resolveAddress, recordAddress } from "../lib/addresses";
import { openBatch, addToBatch, getBatch } from "./graph-batches";
import type { ChangeContext } from "./graphql";
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
type Context = ChangeContext & ActionContext;
export const creativeSchemas = {
  CreativeBrief: brief,
  PromptFragment: fragment,
  Storyboard: storyboard,
  GenerationSnapshot: generationSnapshot,
  CreativeCandidate: candidate,
  CreativeSelection: selection,
  CreativeFeedback: feedback,
};
export const creativeInput = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  kind: z.enum(kinds),
  title: z.string().min(1).max(200),
  body: z.json(),
  subjectId: z.uuid(),
  batchId: z.uuid().optional(),
  slug: z.string().optional(),
});
async function stage(c: Context, input: z.infer<typeof creativeInput>) {
  const body = creativeSchemas[input.kind].parse(input.body);
  if (input.kind === "CreativeSelection") {
    const selected = body as any;
    input = {
      ...input,
      id: await stableGraphId(
        "creative-selection",
        c.identity.installationId,
        selected.use.id,
        selected.slot,
      ),
    };
  }
  const graph = await readGraph(c.db(), c.identity),
    existing = graph.nodes.find((n) => n.id === input.id);
  if (
    existing &&
    input.revision === 0 &&
    existing.typeId === typeIds[input.kind] &&
    canonical(JSON.parse(existing.body || "{}")) === canonical(body)
  )
    return { batchId: null, state: "committed", recordId: existing.id };
  if (!graph.nodes.some((n) => n.id === input.subjectId))
    throw new Response("Subject not found", { status: 404 });
  if (existing) {
    if (existing.typeId !== typeIds[input.kind])
      throw new Response("Record kind cannot change", { status: 409 });
    if (existing.revision !== input.revision)
      throw new Response("Record changed; reload", { status: 409 });
    if (input.kind === "CreativeCandidate")
      throw new Response(
        "Candidates are immutable; register another candidate or a CreativeFeedback record",
        { status: 409 },
      );
    if (input.kind === "GenerationSnapshot")
      throw new Response("Snapshots are immutable; create a new snapshot", {
        status: 409,
      });
  } else if (input.revision !== 0)
    throw new Response("Record not found", { status: 404 });

  function checkRefs(value: any) {
    if (!value || typeof value !== "object") return;
    if (value.installationId && value.type === "graph-node") {
      if (value.installationId !== c.identity.installationId)
        throw new Response(
          "Creative references must use this organization graph",
          { status: 403 },
        );
      const node = graph.nodes.find((n) => n.id === value.id);
      if (!node)
        throw new Response("Referenced record not found", { status: 404 });
      if (value.revision !== undefined && node.revision !== value.revision)
        throw new Response("Referenced revision changed; read it again", {
          status: 409,
        });
    }
    for (const item of Object.values(value))
      if (item && typeof item === "object") checkRefs(item);
  }
  checkRefs(body);
  if (input.kind === "GenerationSnapshot") {
    if ((body as any).resolver === "artera/legacy")
      await verifyLegacySnapshot(body as any);
    const { hash, ...manifest } = body as any;
    if (
      manifest.resolver === "creative-workflow/1" &&
      (await digest(canonical(manifest))) !== hash
    )
      throw new Response("Snapshot hash mismatch", { status: 400 });
    if (manifest.resolver === "creative-workflow/1") {
      const fragments = graph.nodes
        .filter((n) => n.typeId === typeIds.PromptFragment)
        .map((n) => ({
          ...fragment.parse(JSON.parse(n.body || "{}")),
          id: n.id,
          revision: n.revision,
          record: {
            installationId: c.identity.installationId,
            type: "graph-node",
            id: n.id,
            revision: n.revision,
          },
        }));
      const expected = await freeze({
        root: manifest.root,
        fragments,
        inputs: manifest.inputs,
        settings: manifest.settings,
      });
      if (expected.hash !== hash)
        throw new Response(
          "Frozen inputs do not match the committed dependencies; freeze again",
          { status: 409 },
        );
    }
  }
  if (input.kind === "CreativeSelection") {
    const value = body as any;
    const chosen = graph.nodes.find((n) => n.id === value.candidate.id);
    if (chosen?.typeId !== typeIds.CreativeCandidate)
      throw new Response("Selection must name a committed candidate", {
        status: 400,
      });
    const existingSelection = graph.nodes.find(
      (n) =>
        n.id !== input.id &&
        n.typeId === typeIds.CreativeSelection &&
        (() => {
          const b = JSON.parse(n.body || "{}");
          return b.use?.id === value.use.id && b.slot === value.slot;
        })(),
    );
    if (existingSelection)
      throw new Response("Update the existing selection at its revision", {
        status: 409,
      });
  }
  const attributes = {
    id: input.id,
    typeId: typeIds[input.kind],
    title: input.title,
    body: JSON.stringify(body),
    properties: {},
    archived: false,
    ...(input.slug ? { slug: input.slug } : {}),
  };
  const creativeRef = `$creative_${input.id.replaceAll("-", "")}`;
  const operation = existing
    ? {
        operation: "update" as const,
        ref: creativeRef,
        type: "graph-node" as const,
        id: input.id,
        revision: input.revision,
        attributes,
      }
    : {
        operation: "create" as const,
        ref: creativeRef,
        type: "graph-node" as const,
        attributes,
      };
  const proposals: any[] = [{ operation }];
  if (!existing)
    proposals.push({
      operation: {
        operation: "create",
        ref: `$subject_${input.id.replaceAll("-", "")}`,
        type: "graph-edge",
        attributes: {
          typeId: "bce00000-0000-4000-8000-000000000007",
          fromId: creativeRef,
          toId: input.subjectId,
        },
      },
    });
  const batchId =
    input.batchId ??
    (
      await openBatch(c.db(), c.identity, c.actor, {
        title: input.title,
        purpose: "Shared creative workflow",
        anchors: [input.subjectId],
        policy: { kind: "member" },
      })
    ).batch.id;
  await addToBatch(c.db(), c.identity, c.actor, { batchId, proposals });
  return {
    batchId,
    state: (await getBatch(c.db(), c.identity, { batchId })).batch.state,
    recordId: input.id,
  };
}
const freezeInput = z.strictObject({
  id: z.uuid(),
  rootId: z.uuid(),
  subjectId: z.uuid(),
  title: z.string().min(1),
  inputs: z.array(artifact).default([]),
  settings: z.record(z.string(), z.json()).default({}),
  batchId: z.uuid().optional(),
});
export const creativeQueries = {
  creativeRecords: {
    type: JSONScalar,
    args: {
      kind: { type: GraphQLString },
      after: { type: GraphQLString },
      limit: { type: GraphQLInt },
    },
    resolve: async (
      _s: unknown,
      args: { kind?: string; after?: string; limit?: number },
      c: ChangeContext,
    ) => {
      const graph = await readGraph(c.db(), c.identity);
      const records = graph.nodes
        .filter(
          (n) =>
            Object.values(typeIds).includes(n.typeId) &&
            (!args.kind || n.typeId === typeIds[args.kind as CreativeKind]) &&
            (!args.after || n.id > args.after),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      const limit = Math.max(1, Math.min(50, args.limit ?? 20));
      const items = await Promise.all(
        records.slice(0, limit).map(async (n) => {
          const body = JSON.parse(n.body || "{}");
          let status: any;
          if (n.typeId === typeIds.CreativeCandidate) {
            const snapshotNode = graph.nodes.find(
              (s) =>
                s.id === body.snapshot?.id &&
                s.typeId === typeIds.GenerationSnapshot,
            );
            if (!snapshotNode) status = { state: "unknown", changed: [] };
            else {
              const saved = JSON.parse(snapshotNode.body || "{}");
              try {
                if (saved.resolver !== "creative-workflow/1")
                  throw Error(
                    "Historical Artera snapshot retained; use its legacy resolver to compare source files",
                  );
                const current = await freeze({
                  root: saved.root,
                  fragments: graph.nodes
                    .filter((f) => f.typeId === typeIds.PromptFragment)
                    .map((f) => ({
                      ...fragment.parse(JSON.parse(f.body || "{}")),
                      id: f.id,
                      revision: f.revision,
                      record: {
                        installationId: c.identity.installationId,
                        type: "graph-node",
                        id: f.id,
                        revision: f.revision,
                      },
                    })),
                  inputs: saved.inputs,
                  settings: saved.settings,
                });
                status = drift(saved, current);
              } catch (error) {
                status = {
                  state:
                    saved.resolver === "creative-workflow/1"
                      ? "stale"
                      : "unknown",
                  changed: ["unresolved dependencies"],
                  reason:
                    error instanceof Error
                      ? error.message
                      : "Unable to resolve current inputs",
                };
              }
            }
          }
          return { ...n, body, ...(status ? { drift: status } : {}) };
        }),
      );
      return {
        items,
        next: records.length > limit ? records[limit - 1].id : null,
      };
    },
  },
};
export const creativeMutations = {
  stageCreativeRecord: mutationField<typeof creativeInput, Context>({
    name: "StageCreativeRecord",
    input: creativeInput,
    description:
      "Stage a typed creative record for ordinary graph review. No generation or approval occurs.",
    run: stage,
  }),
  freezeCreativeInputs: mutationField<typeof freezeInput, Context>({
    name: "FreezeCreativeInputs",
    input: freezeInput,
    description:
      "Resolve committed prompt fragments and stage an immutable snapshot for review. Does not generate media.",
    run: async (c, input) => {
      const graph = await readGraph(c.db(), c.identity);
      const fragments = graph.nodes
        .filter((n) => n.typeId === typeIds.PromptFragment)
        .map((n) => ({
          ...fragment.parse(JSON.parse(n.body || "{}")),
          id: n.id,
          revision: n.revision,
          record: {
            installationId: c.identity.installationId,
            type: "graph-node",
            id: n.id,
            revision: n.revision,
          },
        }));
      const snapshot = await freeze({
        root: input.rootId,
        fragments,
        inputs: input.inputs,
        settings: input.settings,
      });
      return stage(c, {
        id: input.id,
        revision: 0,
        kind: "GenerationSnapshot",
        title: input.title,
        subjectId: input.subjectId,
        body: snapshot,
        ...(input.batchId ? { batchId: input.batchId } : {}),
      });
    },
  }),
};

const addressedInput = z.strictObject({
  address: z.string().regex(/^[A-Za-z]+:[a-z0-9][a-z0-9-]*$/),
  revision: z.number().int().nonnegative(),
  kind: z.enum(kinds),
  title: z.string().min(1).max(200),
  body: z.json(),
  subject: z.string().min(1),
  batchId: z.uuid().optional(),
});
async function addressedStage(
  c: Context,
  input: z.infer<typeof addressedInput>,
) {
  const graph = await readGraph(c.db(), c.identity),
    index = addressIndex(graph),
    [kind, slug] = input.address.split(":");
  if (kind !== input.kind)
    throw new Response("Address type must match the creative record kind", {
      status: 400,
    });
  const existing = index["graph-node"].get(input.address),
    id =
      existing ??
      (await stableGraphId(
        "creative-address",
        c.identity.installationId,
        input.address,
      ));
  function resolveRefs(value: any): any {
    if (Array.isArray(value)) return value.map(resolveRefs);
    if (!value || typeof value !== "object") return value;
    const result: any = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveRefs(v)]),
    );
    if (result.type === "graph-node" && typeof result.id === "string")
      result.id = resolveAddress(index, "graph-node", result.id);
    return result;
  }
  const body = resolveRefs(input.body);
  if (input.kind === "PromptFragment") {
    body.id = id;
    body.revision = input.revision + 1;
    body.references = (body.references ?? []).map((ref: string) =>
      resolveAddress(index, "graph-node", ref),
    );
  }
  const result = await stage(c, {
    id,
    slug,
    kind: input.kind,
    revision: input.revision,
    title: input.title,
    body,
    subjectId: resolveAddress(index, "graph-node", input.subject),
    ...(input.batchId ? { batchId: input.batchId } : {}),
  });
  return {
    batchId: result.batchId,
    state: result.state,
    address:
      recordAddress(graph)("graph-node", result.recordId) ?? input.address,
  };
}
const addressedFreeze = z.strictObject({
  address: z.string().regex(/^GenerationSnapshot:[a-z0-9][a-z0-9-]*$/),
  root: z.string().min(1),
  subject: z.string().min(1),
  title: z.string().min(1),
  inputs: z.array(artifact).default([]),
  settings: z.record(z.string(), z.json()).default({}),
  batchId: z.uuid().optional(),
});
export const creativeAddressMutations = {
  stageCreativeRecordAtAddress: mutationField<typeof addressedInput, Context>({
    name: "StageCreativeRecordAtAddress",
    input: addressedInput,
    description:
      "Stage a typed creative record named by Type:slug through graph review.",
    run: addressedStage,
  }),
  freezeCreativeInputsAtAddress: mutationField<typeof addressedFreeze, Context>(
    {
      name: "FreezeCreativeInputsAtAddress",
      input: addressedFreeze,
      description:
        "Resolve a named committed prompt and stage a new immutable snapshot.",
      run: async (c, input) => {
        const graph = await readGraph(c.db(), c.identity),
          index = addressIndex(graph);
        const fragments = graph.nodes
          .filter((n) => n.typeId === typeIds.PromptFragment)
          .map((n) => ({
            ...fragment.parse(JSON.parse(n.body || "{}")),
            id: n.id,
            revision: n.revision,
            record: {
              installationId: c.identity.installationId,
              type: "graph-node",
              id: n.id,
              revision: n.revision,
            },
          }));
        const snapshot = await freeze({
          root: resolveAddress(index, "graph-node", input.root),
          fragments,
          inputs: input.inputs,
          settings: input.settings,
        });
        return addressedStage(c, {
          address: input.address,
          kind: "GenerationSnapshot",
          title: input.title,
          revision: 0,
          body: snapshot,
          subject: input.subject,
          ...(input.batchId ? { batchId: input.batchId } : {}),
        });
      },
    },
  ),
};
export const creativeAddressQueries = {
  creativeRecordViews: {
    ...creativeQueries.creativeRecords,
    resolve: async (source: unknown, args: any, c: ChangeContext) => {
      const graph = await readGraph(c.db(), c.identity),
        name = recordAddress(graph),
        page = await creativeQueries.creativeRecords.resolve(
          source,
          { ...args, ...(args.after ? { after: atob(args.after) } : {}) },
          c,
        );
      function view(value: any): any {
        if (typeof value === "string")
          return name("graph-node", value) ?? value;
        if (Array.isArray(value)) return value.map(view);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, v]) => [key, view(v)]),
          );
        return value;
      }
      return {
        items: page.items.map((n) => ({
          address: name("graph-node", n.id),
          kind: Object.entries(typeIds).find(([, id]) => id === n.typeId)?.[0],
          revision: n.revision,
          title: n.title,
          bodyView: view(n.body),
          ...("drift" in n ? { drift: view(n.drift) } : {}),
        })),
        next: page.next ? btoa(page.next) : null,
      };
    },
  },
};
