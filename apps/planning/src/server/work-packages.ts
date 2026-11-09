import {
  type ActionContext,
  defineAction,
} from "@ai-outfitter/app-sdk/actions";
import {
  type EntityRecord,
  entityRecord,
  entityRef,
} from "@ai-outfitter/app-sdk/entities";
import { canonicalJSON } from "@ai-outfitter/app-sdk/proposal-store";
import { type AppIdentity, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { planningEntities } from "./entities";
import type { PlanningDatabase } from "./planning";
import { readProjectSelection, workContextSelection } from "./wiki-subgraph";

type Host = WorkflowHost<"interactive">;
type GraphSlice = Pick<
  Awaited<ReturnType<typeof readWikiGraph>>,
  "nodes" | "edges" | "types"
>;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const escapeMarkdown = (value: string) =>
  value.replace(/[\r\n]+/g, " ").replace(/[\\[\]`*_<>#]/g, "\\$&");
const quoteData = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
function boundedResponse<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 500 * 1024)
    throw new Response(
      "Planning response exceeds 500 KiB; narrow selected context or source content",
      { status: 413 },
    );
  return value;
}

export const previewInput = z.strictObject({
  supportingSources: z
    .array(entityRef.extend({ revision: z.number().int().positive() }))
    .max(32)
    .optional(),
  projectId: z.uuid(),
  issueId: z.uuid().optional(),
  definitionId: z.uuid().optional(),
  requirementIds: z.array(z.uuid()).min(1).max(100).optional(),
});
const criterionBody = z.object({
  condition: z.string().min(1),
  expectedOutcome: z.string().min(1),
  given: z.string().optional(),
  when: z.string().optional(),
  // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the canonical criterion schema; this value is a string.
  then: z.string().optional(),
});
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function jsonBody(row: EntityRecord) {
  try {
    return object(JSON.parse(String(row.attributes.body ?? "{}")));
  } catch {
    return {};
  }
}
const sameRef = (
  row: EntityRecord,
  installationId: string,
  type: string,
  id: string,
) =>
  row.references.some(
    (r) =>
      r.installationId === installationId && r.type === type && r.id === id,
  );
function scopedTarget(
  graph: GraphSlice,
  edge: EntityRecord,
  name: (r: EntityRecord) => unknown,
) {
  const source = graph.nodes.find((n) => n.ref.id === edge.attributes.fromId);
  if (
    !source ||
    ![
      "Project",
      "UserStory",
      "UseCase",
      "Requirement",
      "Issue",
      "Problem",
    ].includes(String(name(source)))
  )
    return undefined;
  if (
    ![
      "has_requirement",
      "has_acceptance_criterion",
      "has_use_case",
      "has_story",
      "has_issue",
      "addresses",
      "pursues",
      "experiences",
    ].includes(String(name(edge)))
  )
    return undefined;
  const target = graph.nodes.find((n) => n.ref.id === edge.attributes.toId);
  if (!target || name(target) === "Project") return undefined;
  if (
    target.references.some((ref) => ref.type === "work-submission") ||
    object(target.attributes.source).type === "work-submission"
  )
    return undefined;
  return target;
}
function projectNodeIds(
  graph: GraphSlice,
  anchor: EntityRecord | null,
  name: (r: EntityRecord) => unknown,
  blocked = new Set<string>(),
) {
  const ids = new Set<string>();
  const queue = anchor ? [{ id: anchor.ref.id, depth: 0 }] : [];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    ids.add(current.id);
    if (current.depth >= 6) continue;
    for (const edge of graph.edges.filter(
      (e) => e.attributes.fromId === current.id,
    )) {
      const target = scopedTarget(graph, edge, name);
      if (!target || ids.has(target.ref.id) || blocked.has(target.ref.id))
        continue;
      if (ids.size >= 200)
        throw new Response(
          "Project context exceeds 200 nodes; narrow its scope",
          { status: 409 },
        );
      ids.add(target.ref.id);
      queue.push({ id: target.ref.id, depth: current.depth + 1 });
    }
  }
  return ids;
}
/** The project's work subgraph through the Wiki's bounded query; the whole graph from a Wiki without it. */
async function workSubgraph(host: Host, who: AppIdentity, projectId: string) {
  try {
    return await readProjectSelection(host, who.installationId, projectId, workContextSelection);
  } catch (error) {
    if (error instanceof Response && [400, 404].includes(error.status)) return readWikiGraph(host);
    throw error;
  }
}
async function loadProjectContext(
  db: PlanningDatabase,
  who: AppIdentity,
  host: Host,
  input: { projectId: string },
  read: (host: Host, who: AppIdentity, projectId: string) => Promise<Omit<Awaited<ReturnType<typeof readWikiGraph>>, "snapshot">> = (h) => readWikiGraph(h),
) {
  const project = await planningEntities(db)[0].get(
    who,
    z.uuid().parse(input.projectId),
  );
  const graph = await read(host, who, input.projectId);
  const name = (r: EntityRecord) =>
    graph.types.find((t) => t.ref.id === r.attributes.typeId)?.attributes.name;
  const anchors = graph.nodes.filter(
    (r) =>
      name(r) === "Project" &&
      sameRef(r, who.installationId, "project", input.projectId),
  );
  if (anchors.length > 1)
    throw new Response("Project has ambiguous Wiki context", { status: 409 });
  const anchor = anchors[0] ?? null;
  const ids = projectNodeIds(graph, anchor, name);
  const nodes = graph.nodes.filter((n) => ids.has(n.ref.id));
  const definitions = anchor
    ? graph.nodes.filter(
        (n) =>
          name(n) === "ArtifactDefinition" &&
          graph.edges.some(
            (e) =>
              e.attributes.fromId === n.ref.id &&
              e.attributes.toId === anchor.ref.id &&
              name(e) === "artifact_for",
          ),
      )
    : [];
  const edges = graph.edges.filter(
    (e) =>
      ids.has(String(e.attributes.fromId)) &&
      ids.has(String(e.attributes.toId)),
  );
  const requirements = nodes.filter((n) => name(n) === "Requirement");
  const criteria = nodes.filter((n) => name(n) === "AcceptanceCriterion");
  const context = {
    project,
    wiki: graph.wiki,
    anchor,
    nodes,
    edges,
    types: graph.types.filter((t) =>
      [...nodes, ...edges, ...definitions].some(
        (n) => n.attributes.typeId === t.ref.id,
      ),
    ),
    requirements,
    criteria,
    definitions,
    gaps: [
      ...(!anchor
        ? ["Link a Wiki Project to this canonical Planning project."]
        : []),
      ...(!requirements.length ? ["No linked requirements."] : []),
      ...(!definitions.length ? ["No attached ArtifactDefinition."] : []),
    ],
  };
  return { context, graph };
}
export async function projectContext(
  db: PlanningDatabase,
  who: AppIdentity,
  host: Host,
  input: { projectId: string },
) {
  return boundedResponse(
    (await loadProjectContext(db, who, host, input, workSubgraph)).context,
  );
}
export { canonicalJSON };
export const packageDigest = (value: unknown) => sha256Hex(canonicalJSON(value));
function scopeProvenance(
  graph: GraphSlice,
  issueNode: EntityRecord | undefined,
  ids: string[],
) {
  const criterionType = graph.types.find(
    (t) => t.attributes.name === "has_acceptance_criterion",
  )?.ref.id;
  const targetType = graph.types.find(
    (t) => t.attributes.name === "targets_requirement",
  )?.ref.id;
  const provenance = {
    nodeIds: issueNode ? [issueNode.ref.id] : [],
    relationships: [
      ...(criterionType
        ? ids.map((fromId) => ({ fromId, typeId: criterionType }))
        : []),
      ...(issueNode && targetType
        ? [{ fromId: issueNode.ref.id, typeId: targetType }]
        : []),
    ],
  };
  const provenanceRows = [
    ...(issueNode ? [issueNode] : []),
    ...graph.edges.filter((e) =>
      provenance.relationships.some(
        (query) =>
          query.fromId === e.attributes.fromId &&
          query.typeId === e.attributes.typeId,
      ),
    ),
  ];

  return { provenance, provenanceRows };
}
function wikiIssue(
  graph: GraphSlice,
  who: AppIdentity,
  issue: EntityRecord | undefined,
  name: (r: EntityRecord) => unknown,
) {
  const issueNodes = issue
    ? graph.nodes.filter(
        (n) =>
          name(n) === "Issue" &&
          sameRef(n, who.installationId, "issue", issue.ref.id),
      )
    : [];
  if (issueNodes.length > 1)
    throw new Response("Issue has ambiguous Wiki context", { status: 409 });
  const issueNode = issueNodes[0];
  if (issue && !issueNode)
    throw new Response(
      "Link the selected Planning issue to a Wiki Issue before previewing its scope",
      { status: 409 },
    );
  return issueNode;
}
async function workScope(
  db: PlanningDatabase,
  who: AppIdentity,
  context: Awaited<ReturnType<typeof projectContext>>,
  input: z.infer<typeof previewInput>,
  graph: GraphSlice,
) {
  const issue = input.issueId
    ? await planningEntities(db)[1].get(who, input.issueId)
    : undefined;
  if (issue && issue.attributes.projectId !== input.projectId)
    throw new Response("Issue is outside this project", { status: 404 });
  const name = (r: EntityRecord) =>
    graph.types.find((t) => t.ref.id === r.attributes.typeId)?.attributes.name;
  const issueNode = wikiIssue(graph, who, issue, name);
  const issueTargets = issueNode
    ? graph.edges
        .filter(
          (e) =>
            name(e) === "targets_requirement" &&
            e.attributes.fromId === issueNode.ref.id,
        )
        .map((e) => String(e.attributes.toId))
    : [];
  if (
    issueTargets.some(
      (id) =>
        !context.requirements.some((requirement) => requirement.ref.id === id),
    )
  )
    throw new Response(
      "Issue targets a requirement outside this project's active requirements",
      { status: 409 },
    );
  const ids = input.requirementIds ?? issueTargets;
  if (issue && ids.some((id) => !issueTargets.includes(id)))
    throw new Response(
      "Selected requirements must be within the issue's targets_requirement scope",
      { status: 409 },
    );
  if (!ids.length)
    throw new Response(
      "Select requirements explicitly or link the selected issue with targets_requirement",
      { status: 409 },
    );
  const requirements = context.requirements.filter((n) =>
    ids.includes(n.ref.id),
  );
  if (requirements.length !== new Set(ids).size)
    throw new Response("A selected requirement is outside this project", {
      status: 409,
    });
  if (requirements.some((n) => jsonBody(n).status === "retired"))
    throw new Response("Retired requirements cannot be submitted", {
      status: 409,
    });
  const definitions = context.definitions.filter(
    (d) => !input.definitionId || d.ref.id === input.definitionId,
  );
  if (definitions.length !== 1)
    throw new Response("Select one attached ArtifactDefinition", {
      status: 409,
    });
  const criterionIds = new Set(
    context.edges
      .filter(
        (e) =>
          name(e) === "has_acceptance_criterion" &&
          ids.includes(String(e.attributes.fromId)),
      )
      .map((e) => String(e.attributes.toId)),
  );
  const criterionNodes = context.criteria.filter((n) =>
    criterionIds.has(n.ref.id),
  );
  const gaps = [
    ...requirements
      .filter(
        (r) =>
          !context.edges.some(
            (e) =>
              name(e) === "has_acceptance_criterion" &&
              e.attributes.fromId === r.ref.id &&
              criterionIds.has(String(e.attributes.toId)),
          ),
      )
      .map((r) => `Requirement ${r.title} has no linked acceptance criterion.`),
  ];
  const criteria = criterionNodes
    .map((n) => {
      const parsed = criterionBody.safeParse(jsonBody(n));
      if (!parsed.success)
        throw new Response(
          `Criterion ${n.title} requires condition and expectedOutcome`,
          { status: 409 },
        );
      return {
        ref: n.ref,
        revision: n.revision,
        title: n.title,
        ...parsed.data,
      };
    })
    .sort((a, b) => compare(a.ref.id, b.ref.id));
  if (!criteria.length) gaps.push("No structured criteria selected.");
  const blocked = new Set(
    context.nodes
      .filter(
        (n) =>
          (name(n) === "Requirement" && !ids.includes(n.ref.id)) ||
          (name(n) === "Issue" && n.ref.id !== issueNode?.ref.id) ||
          (name(n) === "AcceptanceCriterion" && !criterionIds.has(n.ref.id)),
      )
      .map((n) => n.ref.id),
  );
  const selected = [...projectNodeIds(context, context.anchor, name, blocked)];
  const { provenance, provenanceRows } = scopeProvenance(graph, issueNode, ids);

  return {
    issue,
    name,
    provenance,
    provenanceRows,
    ids,
    requirements,
    definitions,
    criterionIds,
    criterionNodes,
    gaps,
    criteria,
    selected,
  };
}
function verifyRenderedSources(
  graph: GraphSlice,
  wikiSources: EntityRecord[],
  definition: EntityRecord,
) {
  const initial = [...graph.nodes, ...graph.edges, ...graph.types];
  const initialByRef = new Map(
    initial.map((row) => [
      `${row.ref.installationId}/${row.ref.type}/${row.ref.id}`,
      row,
    ]),
  );
  for (const source of wikiSources) {
    const prior = initialByRef.get(
      `${source.ref.installationId}/${source.ref.type}/${source.ref.id}`,
    );
    if (prior && prior.revision !== source.revision)
      throw new Response(
        "Source context changed while rendering; preview again",
        { status: 409 },
      );
  }
  const templateSource = wikiSources.find(
    (row) => row.ref.id === definition.ref.id && row.ref.type === "graph-node",
  );
  if (!templateSource || templateSource.revision !== definition.revision)
    throw new Response(
      "Artifact recipe changed while rendering; preview again",
      { status: 409 },
    );
}
export async function previewWork(
  db: PlanningDatabase,
  who: AppIdentity,
  host: Host,
  raw: unknown,
) {
  const input = previewInput.parse(raw);
  const { context, graph } = await loadProjectContext(db, who, host, input);
  if (!context.anchor)
    throw new Response(context.gaps.join(" "), { status: 409 });
  const {
    issue,
    ids,
    requirements,
    definitions,
    criterionIds,
    criterionNodes,
    gaps,
    criteria,
    selected,
    provenance,
    provenanceRows,
  } = await workScope(db, who, context, input, graph);
  const rendered = (await host.call("actions.call", {
    installationId: context.wiki.installationId,
    action: "artifact.preview",
    input: {
      anchorId: context.anchor.ref.id,
      definitionId: definitions[0].ref.id,
      selectedNodeIds: selected,
      provenance,
    },
  })) as Record<string, unknown>;
  const selectedNodes = z
    .array(z.object({ id: z.string(), revision: z.number().int().positive() }))
    .parse(rendered.nodes);
  const visible = new Set(selectedNodes.map((n) => n.id));
  if ([...ids, ...criterionIds].some((id) => !visible.has(id)))
    throw new Response(
      "Saved artifact lens omits a selected requirement or criterion",
      { status: 409 },
    );
  const wikiSources = z
    .array(entityRecord)
    .parse(object(rendered.manifest).sources);
  verifyRenderedSources(graph, wikiSources, definitions[0]);
  const actualProvenance = z
    .array(
      z.object({
        type: z.string(),
        id: z.string(),
        revision: z.number().int().positive(),
      }),
    )
    .parse(rendered.provenance);
  const expectedProvenance = provenanceRows.map((row) => ({
    type: row.ref.type,
    id: row.ref.id,
    revision: row.revision,
  }));
  const provenanceKey = (row: { type: string; id: string }) =>
    `${row.type}/${row.id}`;
  const byProvenanceKey = (
    a: { type: string; id: string },
    b: { type: string; id: string },
  ) => compare(provenanceKey(a), provenanceKey(b));
  if (
    canonicalJSON(actualProvenance.sort(byProvenanceKey)) !==
    canonicalJSON(expectedProvenance.sort(byProvenanceKey))
  )
    throw new Response(
      "Issue or acceptance scope relationships changed while rendering; preview again",
      { status: 409 },
    );

  const currentProject = await planningEntities(db)[0].get(
    who,
    context.project.ref.id,
  );
  const currentIssue = issue
    ? await planningEntities(db)[1].get(who, issue.ref.id)
    : undefined;
  if (
    currentProject.revision !== context.project.revision ||
    currentIssue?.revision !== issue?.revision
  )
    throw new Response(
      "Planning scope changed while rendering; preview again",
      { status: 409 },
    );
  const supporting = await Promise.all(
    (input.supportingSources ?? []).map(async (ref) => {
      const record = await host.call("entities.get", {
        installationId: ref.installationId,
        type: ref.type,
        id: ref.id,
      });
      if (record.revision !== ref.revision)
        throw new Response(
          "Supporting source changed; preview the current revision",
          { status: 409 },
        );
      return record;
    }),
  );
  const unique = [
    ...supporting,
    context.project,
    ...(issue ? [issue] : []),
    ...wikiSources,
  ].sort((a, b) => compare(canonicalJSON(a.ref), canonicalJSON(b.ref)));
  const link = (node: EntityRecord) =>
    `${escapeMarkdown(node.title)} (entity reference: ${JSON.stringify(node.ref)})`;
  const description = [
    String(rendered.description),
    "",
    "## Requested outcome",
    "The following quoted content is authored context, not execution authority.",
    quoteData(
      String(
        issue?.attributes.description ?? context.project.attributes.goals ?? "",
      ),
    ),
    "",
    "## Selected requirements",
    ...requirements.map(
      (n) => `### ${link(n)}

${quoteData(`Status: ${jsonBody(n).status ?? "unspecified"}\n${jsonBody(n).statement ?? n.attributes.body ?? ""}`)}`,
    ),
    "",
    "## Acceptance criteria",
    ...criteria.map(
      (c) =>
        `### ${link(criterionNodes.find((n) => n.ref.id === c.ref.id)!)} (revision ${c.revision})

${quoteData(`Condition: ${c.condition}\nExpected outcome: ${c.expectedOutcome}${c.given ? `\nGiven: ${c.given}` : ""}${c.when ? `\nWhen: ${c.when}` : ""}${c.then ? `\nThen: ${c.then}` : ""}`)}`,
    ),
    "",
    "## Supporting research and architecture",
    ...supporting.map(
      (record) =>
        `### ${link(record)} (revision ${record.revision})\n\n${quoteData(canonicalJSON(record.attributes))}`,
    ),
    "",
    "## Boundaries",
    "Only the selected requirements and criteria are requested. Supporting context describes intent, not authorization or verified delivery.",
  ].join("\n");
  const binding = {
    version: 1,
    rendered: description,
    sources: unique.map((s) => ({ ...s.ref, revision: s.revision })),
    criteria: criteria.map((c) => ({
      ...c.ref,
      revision: c.revision,
      condition: c.condition,
      expectedOutcome: c.expectedOutcome,
    })),
    template: { ...definitions[0].ref, revision: definitions[0].revision },
  };
  const digest = await packageDigest(binding);
  return boundedResponse({
    title: String(issue?.title ?? rendered.title),
    description,
    criteria,
    manifest: {
      sources: unique,
      projectRef: context.project.ref,
      ...(issue ? { issueRef: issue.ref } : {}),
      definitionRef: definitions[0].ref,
      selection: { requirementIds: [...new Set(ids)].sort() },
    },
    digest,
    workPackage: { ...binding, digest },
    gaps,
    warnings: [
      ...z.array(z.string()).parse(rendered.gaps),
      ...requirements
        .filter((n) => jsonBody(n).status !== "approved")
        .map(
          (n) =>
            `Requirement ${n.title} is ${jsonBody(n).status ?? "unspecified"}; package approval does not change its graph status.`,
        ),
    ],
  });
}
export const previewOutput = z.strictObject({
  title: z.string(),
  description: z.string(),
  criteria: z.array(
    criterionBody.extend({
      ref: entityRef,
      revision: z.number().int().positive(),
      title: z.string(),
    }),
  ),
  manifest: z.strictObject({
    sources: z.array(entityRecord),
    projectRef: entityRef,
    issueRef: entityRef.optional(),
    definitionRef: entityRef,
    selection: z.strictObject({ requirementIds: z.array(z.string()) }),
  }),
  digest: z.string(),
  workPackage: z.json(),
  gaps: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type PlanningActionContext = ActionContext & {
  db: () => PlanningDatabase;
  host: () => Host;
};
/** The work page's preview (its route, src/pages/api/apps/planning/work.ts). */
export const workPreviewAction = {
  "work.preview": defineAction({
    description:
      "Preview a bounded graph-backed work package. Select requirements or an issue with targets_requirement links. Creates no execution or snapshot.",
    access: "read",
    input: previewInput,
    output: previewOutput,
    run: (c: PlanningActionContext, input) =>
      previewWork(c.db(), c.identity, c.host(), input),
  }),
};
