import type { Graph, GraphNode } from "./graph";

type Json = Record<string, unknown>;
export function evidenceBody(body: string): Json {
  try {
    const text = body.trim().startsWith("{")
      ? body.trim()
      : body.match(/```json\s*\n([\s\S]*?)\n```/i)?.[1];
    const value: unknown = text ? JSON.parse(text) : null;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Json)
      : {};
  } catch {
    return {};
  }
}
export const isRecordType = (graph: Graph, node: GraphNode, name: string) =>
  graph.types.some(
    (type) => !type.archived && type.id === node.typeId && type.name === name,
  );
const string = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const time = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : undefined;

export type EvidenceBundle = {
  node: GraphNode;
  members: GraphNode[];
  capturedMembers: GraphNode[];
  explicitScope: boolean;
  warnings: string[];
  demonstrations: GraphNode[];
  evaluations: GraphNode[];
  reviews: GraphNode[];
  sources: GraphNode[];
  commits: string[];
  clean: boolean | undefined;
  environment?: string;
  capturedAt: number | undefined;
  gallery?: string;
  buildId?: string;
  packageCount: number;
  limitations: string[];
};

function demonstrationSelection(list: GraphNode[], revision: GraphNode) {
  const demonstrations = list.filter(
    (demo) => object(evidenceBody(demo.body).subject).id === revision.id,
  );
  const warnings: string[] = [];
  if (demonstrations.length !== list.length)
    warnings.push(
      "A demonstration names another or unknown subject and has been excluded.",
    );
  for (const demo of demonstrations) {
    if (object(evidenceBody(demo.body).subject).revision !== revision.revision)
      warnings.push(
        `${demo.title}: the demonstrated subject revision differs from the current revision.`,
      );
  }
  return { demonstrations, warnings };
}

function captureCleanliness(captures: Json[]) {
  const dirty = captures.map((capture) => capture.dirty);
  if (dirty.some((value) => value === true)) return false;
  return dirty.length && dirty.every((value) => value === false)
    ? true
    : undefined;
}

/** Read-only projection of one installation's graph. Snapshot members never come
 * from every demonstration connected to the moving revision or shared story. */
export function revisionEvidence(graph: Graph, revision: GraphNode) {
  const nodes = graph.nodes.filter((node) => !node.archived);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const types = new Map(
    graph.types
      .filter((type) => !type.archived)
      .map((type) => [type.name, type.id]),
  );
  const edges = graph.edges.filter(
    (edge) => !edge.archived && byId.has(edge.fromId) && byId.has(edge.toId),
  );
  const related = (id: string, name: string, incoming = false) =>
    edges
      .filter(
        (edge) =>
          edge.typeId === types.get(name) &&
          (incoming ? edge.toId : edge.fromId) === id,
      )
      .flatMap((edge) => {
        const node = byId.get(incoming ? edge.fromId : edge.toId);
        return node ? [node] : [];
      });
  const typed = (list: GraphNode[], name: string) =>
    list.filter((node) => isRecordType(graph, node, name));
  const unique = (list: GraphNode[]) => [
    ...new Map(list.map((node) => [node.id, node])).values(),
  ];
  const inScopeStories = typed(related(revision.id, "has_story"), "UserStory");
  const candidates = unique([
    ...related(revision.id, "documents", true),
    ...related(revision.id, "evidence_for", true),
  ]).filter((node) => isRecordType(graph, node, "Document"));

  const bundles: EvidenceBundle[] = candidates
    .flatMap((node) => {
      // Inspect membership edges even when a member is missing/archived, so that
      // omissions are reported instead of silently disappearing from coverage.
      const membership = graph.edges.filter(
        (edge) =>
          !edge.archived &&
          edge.typeId === types.get("includes_record") &&
          edge.fromId === node.id,
      );
      const explicitScope = membership.length > 0;
      const members = unique(
        explicitScope
          ? membership.flatMap((edge) =>
              [byId.get(edge.toId)].filter((node): node is GraphNode => !!node),
            )
          : [
              ...related(node.id, "supported_by"),
              ...related(node.id, "evidence_for"),
            ],
      );
      const capturedMembers = explicitScope
        ? members.filter((member) =>
            membership.some(
              (edge) =>
                edge.toId === member.id &&
                edge.properties.record_revision === member.revision,
            ),
          )
        : members;
      const warnings = membership.flatMap((edge) => {
        const target = byId.get(edge.toId);
        if (!target)
          return [`A captured member is missing or archived (${edge.toId}).`];
        const pinned = edge.properties.record_revision;
        if (typeof pinned !== "number")
          return [`${target.title}: captured revision is not recorded.`];
        return pinned === target.revision
          ? []
          : [
              `${target.title}: captured revision ${pinned}, current revision ${target.revision}. Consult the frozen scope record.`,
            ];
      });
      const selection = demonstrationSelection(
        typed(capturedMembers, "Demonstration"),
        revision,
      );
      const demonstrations = selection.demonstrations;
      warnings.push(...selection.warnings);
      // A source receipt alone is not an evidence bundle.
      if (!explicitScope && !demonstrations.length) return [];
      if (!explicitScope)
        warnings.push(
          "This bundle does not pin its member revisions. Historical source versions cannot be verified.",
        );
      const sources = typed(capturedMembers, "Document").filter((source) => {
        const body = evidenceBody(source.body);
        return (
          body.sourceAtCapture ||
          body.captureRuns ||
          (body.sourceCommit && !body.assets) ||
          body.source
        );
      });
      const metadata = sources.map((source) => evidenceBody(source.body));
      const captures = metadata.flatMap((meta) => {
        if (meta.sourceAtCapture) return [object(meta.sourceAtCapture)];
        if (meta.captureRuns)
          return array(meta.captureRuns).map((run) =>
            object(object(run).source),
          );
        return meta.source ? [object(meta.source)] : [meta];
      });
      const commits = [
        ...new Set(
          captures
            .map(
              (source) => string(source.commit) ?? string(source.sourceCommit),
            )
            .filter((value): value is string => !!value),
        ),
      ];
      const clean = captureCleanliness(captures);
      const demonstrationBodies = demonstrations.map((demo) =>
        evidenceBody(demo.body),
      );
      const dates = [
        ...metadata.map((meta) => time(meta.capturedAt)),
        ...demonstrationBodies.map((body) => time(body.capturedAt)),
      ].filter((value): value is number => value !== undefined);
      const evaluations = typed(capturedMembers, "EvaluationRecord").filter(
        (evaluation) => {
          const body = evidenceBody(evaluation.body);
          return (
            object(body.subject).id === revision.id &&
            array(body.evidence).some((item) => object(item).id === node.id)
          );
        },
      );
      const limitations = [
        ...new Set(
          demonstrationBodies
            .flatMap((body) => array(body.limitations))
            .filter((value): value is string => typeof value === "string"),
        ),
      ];
      return [
        {
          node,
          members,
          capturedMembers,
          explicitScope,
          warnings,
          demonstrations,
          evaluations,
          reviews: typed(capturedMembers, "ReviewRecord"),
          sources,
          commits,
          clean,
          environment:
            metadata.map((meta) => string(meta.environment)).find(Boolean) ??
            demonstrationBodies
              .map((body) => string(body.environment))
              .find(Boolean),
          capturedAt: dates.length ? Math.min(...dates) : undefined,
          gallery: metadata.map((meta) => string(meta.gallery)).find(Boolean),
          buildId: captures
            .map((capture) => string(capture.buildId))
            .find(Boolean),
          packageCount: Math.max(
            0,
            ...captures.map(
              (capture) => Object.keys(object(capture.appPackages)).length,
            ),
          ),
          limitations,
        },
      ];
    })
    .sort(
      (a, b) =>
        (b.capturedAt ?? -Infinity) - (a.capturedAt ?? -Infinity) ||
        b.node.createdAt - a.node.createdAt ||
        a.node.id.localeCompare(b.node.id),
    );

  function stories(bundle?: EvidenceBundle) {
    const members = new Set(bundle?.members.map((node) => node.id));
    const captured = new Set(bundle?.capturedMembers.map((node) => node.id));
    return unique([
      ...inScopeStories,
      ...typed(bundle?.members ?? [], "UserStory"),
    ]).map((story) => {
      const inCapture = !bundle?.explicitScope || members.has(story.id);
      const sourceChanged =
        !!bundle?.explicitScope &&
        members.has(story.id) &&
        !captured.has(story.id);
      const flows = typed(
        related(story.id, "has_story", true),
        "UseCase",
      ).filter((flow) => !bundle?.explicitScope || captured.has(flow.id));
      const ids = new Set([story.id, ...flows.map((flow) => flow.id)]);
      const demonstrations = inCapture
        ? (bundle?.demonstrations ?? []).filter(
            (demo) =>
              related(demo.id, "evidence_for").some((target) =>
                ids.has(target.id),
              ) ||
              [story, ...flows].some((target) =>
                related(target.id, "supported_by").some(
                  (source) => source.id === demo.id,
                ),
              ),
          )
        : [];
      const media = [
        ...new Set(
          demonstrations
            .flatMap((demo) => array(evidenceBody(demo.body).media))
            .filter((value): value is string => typeof value === "string"),
        ),
      ];
      return {
        node: story,
        inCapture,
        sourceChanged,
        flows,
        demonstrations,
        media,
      };
    });
  }
  return { bundles, stories, revision: evidenceBody(revision.body) };
}

/** Prefer the complete asset path; merge supplementary receipts only for that same path. */
export function screenshotMetadata(assets: Json[], pathname: string): Json {
  const matches = assets.filter(asset => typeof asset.path === "string" && pathname.endsWith(`/${asset.path}`));
  const longest = Math.max(0, ...matches.map(asset => String(asset.path).length));
  return Object.assign({}, ...matches.filter(asset => String(asset.path).length === longest));
}

/** Keep links clickable without fetching arbitrary evidence hosts or local
 * workstation URLs merely because somebody opened a revision page. */
export function evidenceURL(value: string, origin: string) {
  try {
    const url = new URL(value, origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    const hostname = url.hostname.toLowerCase();
    const local =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
    return {
      href: url.href,
      origin: url.origin,
      host: url.host,
      pathname: url.pathname,
      local,
      preview:
        url.origin === origin &&
        /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(url.pathname),
    };
  } catch {
    return null;
  }
}
