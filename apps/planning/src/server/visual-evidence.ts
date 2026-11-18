import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import {
  visualEvidenceSchema,
  evidenceView,
} from "@ai-outfitter/app-sdk/visual-evidence";
import {
  stableGraphId,
  queryWikiGraph,
  defaultWiki,
} from "@ai-outfitter/app-sdk/graph-client";
import { projects } from "./schema";
import type { PlanningContext } from "./intake";
import { readProjectReleases, projectEvidenceViews } from "./project-releases";

export const evidenceReadInput = z.strictObject({
  projectId: z.uuid(),
  bundleId: z.uuid().optional(),
  batchId: z.uuid().optional(),
  after: z.string().optional(),
  limit: z.number().int().min(1).max(30).default(10),
});
export async function readVisualEvidence(c: PlanningContext, raw: unknown) {
  const input = evidenceReadInput.parse(raw);
  if (input.batchId) {
    if (!input.bundleId)
      throw new Response("Pending evidence needs a bundle ID", { status: 400 });
    const [project] = await c
      .db()
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.installationId, c.identity.installationId),
          eq(projects.id, input.projectId),
        ),
      );
    if (!project) throw new Response("Project not found", { status: 404 });
    const wiki = await defaultWiki(c.host());
    const batch = (await c
      .host()
      .call("actions.call", {
        installationId: wiki.installationId,
        action: "batch.get",
        readOnly: true,
        input: { batchId: input.batchId },
      })) as any;
    const proposed = batch.operations?.find(
      (op: any) =>
        op.operation?.type === "graph-node" &&
        op.operation.attributes?.id === input.bundleId,
    );
    const attrs = proposed?.operation.attributes;
    if (
      !attrs ||
      (proposed.state &&
        !["open", "staged", "awaiting_review"].includes(proposed.state)) ||
      !["open", "awaiting_review"].includes(batch.batch.state)
    )
      throw new Response("Pending capture unavailable", { status: 404 });
    const bundle = evidenceView({
      id: input.bundleId,
      revision: 0,
      title: attrs.title,
      body: attrs.body,
    });
    if (bundle.legacy || bundle.project?.id !== input.projectId)
      throw new Response("Capture is not linked to this project", {
        status: 404,
      });
    return {
      bundle,
      projectRevision: project.revision,
      state: batch.batch.state,
      batchId: input.batchId,
    };
  }
  const model = await readProjectReleases(
    c.host(),
    c.identity.installationId,
    input.projectId,
  );
  const bundles = projectEvidenceViews(model);
  if (input.bundleId) {
    const bundle = bundles.find((b) => b.id === input.bundleId);
    if (!bundle)
      throw new Response("Evidence is not linked to this project", {
        status: 404,
      });
    return {
      bundle,
      projectRevision: model.project.revision,
      state: "applied",
    };
  }
  const start = input.after
    ? bundles.findIndex((b) => b.id === input.after) + 1
    : 0;
  if (input.after && start === 0)
    throw new Response("Evidence cursor is unavailable; reload the index", {
      status: 409,
    });
  const selected = bundles.slice(start, start + input.limit);
  return {
    items: selected.map(
      ({ id, revision, title, summary, capturedAt, source, steps }) => ({
        id,
        revision,
        title,
        summary,
        capturedAt,
        source,
        mediaCount: steps.reduce((n, s) => n + s.media.length, 0),
      }),
    ),
    next: bundles.length > start + input.limit ? selected.at(-1)?.id : null,
  };
}
/** A caller opens a graph batch through the existing graph workflow, then stages this capture. */
export const submitEvidenceInput = z.strictObject({
  key: z.string().min(1).max(100),
  batchId: z.uuid(),
  bundle: visualEvidenceSchema,
});
export async function submitVisualEvidence(c: PlanningContext, raw: unknown) {
  requireEditor(c.identity);
  const input = submitEvidenceInput.parse(raw),
    capture = input.bundle;
  const [project] = await c
    .db()
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.installationId, c.identity.installationId),
        eq(projects.id, capture.project.id),
      ),
    );
  if (!project) throw new Response("Project not found", { status: 404 });
  const id = await stableGraphId(
    "visual-evidence",
    c.identity.installationId,
    project.id,
    input.key,
  );
  const wiki = await defaultWiki(c.host());
  const call = (action: string, value: unknown) =>
    c
      .host()
      .call("actions.call", {
        installationId: wiki.installationId,
        action,
        input: JSON.parse(JSON.stringify(value)),
      }) as Promise<any>;
  const ref = `$evidence_${id.replaceAll("-", "")}`;
  const body = JSON.stringify(capture);
  const existing = await queryWikiGraph(c.host(), {
    queries: [
      { name: "existing", entity: "node", ids: [id], fields: "full", limit: 1 },
    ],
  });
  const saved = existing.nodes.find((n) => n.id === id);
  const url = `/projects/${project.id}/evidence?bundle=${id}`;
  if (saved) {
    if (saved.body !== body)
      throw new Response(
        "Submission key already names a different capture; use a new key",
        { status: 409 },
      );
    return { id, state: "applied", url };
  }
  const batch = await call("batch.get", { batchId: input.batchId });
  const prior = batch.operations?.find((p: any) => p.operation?.ref === ref);
  if (prior) {
    if (prior.operation.attributes?.body !== body)
      throw new Response(
        "Submission key already staged with different content",
        { status: 409 },
      );
    return {
      id,
      batchId: input.batchId,
      state: batch.batch.state,
      url: `${url}&batch=${input.batchId}`,
    };
  }
  if (project.revision !== capture.project.revision)
    throw new Response("Project changed; read it again", { status: 409 });
  const graph = await queryWikiGraph(c.host(), {
    queries: [
      {
        name: "anchor",
        entity: "node",
        sources: [
          {
            installationId: c.identity.installationId,
            type: "project",
            id: project.id,
          },
        ],
        fields: "full",
        limit: 2,
        expand: {
          rootTypes: ["Project"],
          relationships: [
            {
              type: "produces",
              direction: "outgoing",
              from_type: "Project",
              to_type: "ProductRevision",
            },
          ],
          terminalTypes: ["ProductRevision"],
          maxDepth: 1,
          maxNodes: 100,
        },
      },
      {
        name: "revision",
        entity: "node",
        ids: [capture.productRevision.id],
        fields: "full",
        limit: 1,
      },
      {
        name: "types",
        entity: "type",
        types: ["Document", "documents", "ProductRevision"],
        fields: "full",
        limit: 10,
      },
    ],
  });
  if (Object.values(graph.queries).some((q) => q.cursor || q.omitted.length))
    throw new Response("Evidence references are incomplete", { status: 413 });
  const anchorIds = graph.queries.anchor.matches;
  const anchor = graph.nodes.filter((n) => anchorIds.includes(String(n.id)));
  const revision = graph.nodes.find((n) => n.id === capture.productRevision.id);
  const type = (name: string) => graph.types.find((t) => t.name === name)?.id;
  if (
    anchor.length !== 1 ||
    !revision ||
    revision.typeId !== type("ProductRevision")
  )
    throw new Response(
      "A canonical project and product revision are required",
      { status: 409 },
    );
  if (!graph.queries.anchor.related.includes(capture.productRevision.id))
    throw new Response("Product revision is not linked to this project", {
      status: 409,
    });
  if (revision.revision !== capture.productRevision.revision)
    throw new Response("Product revision changed; read it again", {
      status: 409,
    });
  if (!type("Document") || !type("documents"))
    throw new Response("Evidence document types are unavailable", {
      status: 409,
    });
  const proposals: any[] = [
    {
      operation: {
        operation: "create",
        ref,
        type: "graph-node",
        attributes: {
          id,
          typeId: type("Document"),
          title: capture.title,
          summary: capture.summary,
          body,
          properties: {},
          archived: false,
        },
      },
    },
  ];
  for (const target of [String(anchor[0].id), capture.productRevision.id]) {
    const linkId = await stableGraphId("visual-evidence-link", id, target);
    proposals.push({
      operation: {
        operation: "create",
        ref: `$link_${linkId.replaceAll("-", "")}`,
        type: "graph-edge",
        attributes: {
          id: linkId,
          typeId: type("documents"),
          fromId: ref,
          toId: target,
          properties: {},
        },
      },
    });
  }
  await call("batch.add", { batchId: input.batchId, proposals });
  return {
    id,
    batchId: input.batchId,
    state: "staged",
    url: `${url}&batch=${input.batchId}`,
    next: "Submit and review the existing graph batch. This capture is not applied yet.",
  };
}
