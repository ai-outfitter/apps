// The picture an exploration describes, rebuilt from any graph source: the Wiki's
// tables on the server (server/explorations.ts), the demo's fixture in the browser.
// A view stores where it starts and which relationships were opened from which
// nodes; it holds no facts (docs/graph-explorer.md).

import { githubRepositoryName, type GithubPullRequest } from "@ai-outfitter/app-sdk/github-pulls";
import type { EdgeRow, GraphRow, GraphSource, TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { applyMergePatch } from "@ai-outfitter/app-sdk/merge-patch";
import { z } from "zod";

export const namedPaths = ["offerings", "products", "projects", "competitors", "issues", "repositories", "pullRequests"] as const;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase letters, digits and hyphens");
const nodeKey = z.string().min(1).max(300).describe("A node address, <Type>:<slug>, as a picture returns it");
const step = z.strictObject({
  from: z.string().min(1).max(300).describe("A node key, or *<step> for every node that step reached"),
  path: z.string().min(1).max(100).describe(`A named path (${namedPaths.join(", ")}) or a Wiki edge type name`),
  direction: z.enum(["outgoing", "incoming"]).optional().describe("For an edge type name: follow edges out of (default) or into the node"),
  limit: z.number().int().min(1).max(100).optional().describe("Most nodes this step adds; default 25"),
  type: z.string().min(1).max(100).optional().describe("Keep only reached nodes of this Wiki type"),
  state: z.enum(["open", "closed", "merged", "all"]).optional().describe("pullRequests only: which pull requests; default open"),
});
export const explorationState = z.strictObject({
  title: z.string().min(1).max(200),
  start: z.strictObject({ type: z.string().min(1).max(100), slug: z.string().min(1).max(200) }),
  steps: z.record(slug, step).default({}),
  hidden: z.record(nodeKey, z.literal(true)).default({}),
  focus: nodeKey.optional(),
  direction: z.enum(["RIGHT", "DOWN"]).optional(),
});
export type ExplorationState = z.infer<typeof explorationState>;

export const mutateExplorationInput = z.strictObject({
  slug: slug.describe("The exploration to change; a new slug with expectedRevision 0 creates it"),
  expectedRevision: z.number().int().min(0).describe("The revision you read; 0 to create"),
  patch: z.record(z.string(), z.unknown()).describe("RFC 7386 merge patch over {title, start, steps, hidden, focus, direction}; null removes a key, e.g. steps: {projects: null}"),
  summary: z.string().max(200).optional().describe("One line the page shows, e.g. \"Opened open pull requests\""),
  dryRun: z.boolean().default(false).describe("Return the resulting picture without saving it"),
});
export const explorationArgs = z.strictObject({ slug });

const maxNodes = 300;
const defaultLimit = 25;

export type PictureNode = {
  key: string; type: string; title: string; slug: string | null; id: string; step: string | null; url: string | null;
  /** The change batch that proposes it; set only for staged records a member has not committed. */
  proposedIn?: string;
};
/** One staged graph.apply operation from an open or submitted change batch. */
export type StagedOperation = { batchId: string; ref: string; operation: Record<string, unknown> };
/** Live reads from outside the Wiki; a path that needs one it lacks reports why on its step. */
export type PictureProviders = {
  /** The newest pull requests of a GitHub repository (`owner/name`). */
  pullRequests?: (repository: string) => Promise<GithubPullRequest[]>;
  /** Staged operations in batches still waiting for a member, shown as proposed records. */
  proposals?: () => Promise<StagedOperation[]>;
};
export const pullRequestLimit = 50;
export type PictureEdge = { from: string; to: string; label: string };
export type PictureStep = { key: string; count: number; truncated: boolean; error: string | null };
export type Picture = { nodes: PictureNode[]; edges: PictureEdge[]; steps: PictureStep[]; truncated: boolean };

type Hop = { edges: string[] | "*"; direction: "outgoing" | "incoming" | "both"; to?: string[]; optional?: boolean };

/** What a named path walks from a node of `type`. Raw edge names walk one hop. */
function hops(path: string, type: string, direction: "outgoing" | "incoming" = "outgoing"): Hop[] {
  switch (path) {
    case "offerings": return [{ edges: ["offered_by"], direction: "incoming", to: ["Offering"] }];
    case "products": return [{ edges: ["packages_product"], direction: "outgoing", to: ["Product"] }];
    case "projects":
      if (type === "Organization") return [{ edges: ["part_of"], direction: "incoming", to: ["Project"] }];
      if (type === "Offering") return [{ edges: ["packages_product"], direction: "outgoing", to: ["Product"] }, { edges: ["produces"], direction: "incoming", to: ["Project"] }];
      return [{ edges: ["produces"], direction: "incoming", to: ["Project"] }];
    case "competitors":
      // What is an alternative for this node, then (when recorded) who offers or develops it.
      return [{ edges: ["alternative_for"], direction: "incoming" }, { edges: ["offered_by", "developed_by"], direction: "outgoing", to: ["Organization"], optional: true }];
    case "issues": return [{ edges: "*", direction: "both", to: ["Issue"] }];
    case "repositories": return [{ edges: ["source_in"], direction: "outgoing", to: ["Repository"] }];
    default: return [{ edges: [path], direction }];
  }
}

/** Steps in an order where every *<step> source runs before the step that names it. */
function ordered(steps: ExplorationState["steps"]) {
  const done = new Set<string>(), order: string[] = [], visiting = new Set<string>();
  const visit = (key: string) => {
    if (done.has(key)) return;
    if (visiting.has(key)) throw new Response(`Steps depend on each other in a loop at ${key}`, { status: 400 });
    visiting.add(key);
    const from = steps[key].from;
    if (from.startsWith("*")) {
      const source = from.slice(1);
      if (!steps[source]) throw new Response(`Step ${key} starts from *${source}, which is not a step`, { status: 400 });
      visit(source);
    }
    visiting.delete(key); done.add(key); order.push(key);
  };
  for (const key of Object.keys(steps).sort()) visit(key);
  return order;
}

/** The pull requests in `state` of each GitHub repository, keyed github:<owner>/<repo>#<number>. */
async function pullsIn(read: NonNullable<PictureProviders["pullRequests"]>, repositories: PictureNode[], state: string) {
  const found: { repository: PictureNode; key: string; pull: GithubPullRequest }[] = [];
  for (const repository of repositories) {
    const name = githubRepositoryName(repository.url);
    if (!name) continue;
    for (const pull of await read(name))
      if (state === "all" || pull.state.toLowerCase() === state) found.push({ repository, key: `github:${name}#${pull.number}`, pull });
  }
  return found;
}

const isNamed = (path: string) => (namedPaths as readonly string[]).includes(path);
const present = (values: (string | undefined)[]) => values.filter((value): value is string => !!value);

/** Builds one picture: the nodes and relationships the steps reach, deduplicated by key. */
class PictureBuilder {
  nodes = new Map<string, PictureNode>();
  edges = new Map<string, PictureEdge>();
  byId = new Map<string, string>();
  truncated = false;
  private typeName: Map<string, string>;
  private typeId: Map<string, string>;
  private edgeTypeId: Map<string, string>;

  constructor(private source: GraphSource, types: TypeRow[], private hidden: Set<string>, private providers: PictureProviders) {
    this.typeName = new Map(types.map(type => [type.id, String(type.name)]));
    this.typeId = new Map(types.filter(type => type.category === "node").map(type => [String(type.name), type.id]));
    this.edgeTypeId = new Map(types.filter(type => type.category === "edge").map(type => [String(type.name), type.id]));
  }

  nodeTypeIds = (names: string[] | undefined) => names && present(names.map(name => this.typeId.get(name)));

  /** Adds a node unless it is hidden or the picture is full; returns its key when it is in the picture. */
  add(node: GraphRow, step: string | null) {
    const type = this.typeName.get(node.typeId) ?? "Entity";
    const key = `${type}:${node.slug ?? node.id}`;
    if (this.hidden.has(key)) return null;
    if (this.nodes.has(key)) return key;
    if (this.nodes.size >= maxNodes) { this.truncated = true; return null; }
    this.nodes.set(key, { key, type, title: String(node.title), slug: node.slug ? String(node.slug) : null, id: node.id, step, url: typeof node.website === "string" ? node.website : null });
    this.byId.set(node.id, key);
    return key;
  }

  link(edge: EdgeRow) {
    const from = this.byId.get(edge.fromId), to = this.byId.get(edge.toId);
    if (from && to) this.edges.set(`${from}|${edge.typeId}|${to}`, { from, to, label: this.typeName.get(edge.typeId) ?? "related" });
  }

  async find(type: string, slugOrId: string) {
    const typeIds = this.nodeTypeIds([type]);
    if (!typeIds?.length) return undefined;
    const [bySlug] = await this.source.nodes({ typeIds, slugs: [slugOrId] });
    return bySlug ?? (await this.source.nodes({ typeIds, ids: [slugOrId] }))[0];
  }

  /** The node a step names by key, read once. */
  async idFor(key: string) {
    const known = [...this.nodes.values()].find(node => node.key === key);
    if (known) return known.id;
    const match = /^([^:]+):(.+)$/.exec(key);
    return match ? (await this.find(match[1], match[2]))?.id : undefined;
  }

  /** One hop from `frontier`: the edges it follows and the nodes at their other ends. */
  async hop(hop: Hop, frontier: string[], wantedTypes: string[] | undefined) {
    const typeIds = hop.edges === "*" ? undefined : present(hop.edges.map(name => this.edgeTypeId.get(name)));
    if (typeIds && !typeIds.length) return null;
    const links: EdgeRow[] = [
      ...(hop.direction === "incoming" ? [] : await this.source.edges({ typeIds, fromIds: frontier })),
      ...(hop.direction === "outgoing" ? [] : await this.source.edges({ typeIds, toIds: frontier })),
    ];
    const inFrontier = new Set(frontier);
    const otherIds = [...new Set(links.map(link => (inFrontier.has(link.fromId) ? link.toId : link.fromId)))];
    const wanted = this.nodeTypeIds(wantedTypes);
    const others = otherIds.length ? await this.source.nodes({ ids: otherIds, ...(wanted ? { typeIds: wanted } : {}) }) : [];
    return { links, others };
  }

  /** Adds the nodes a hop reached, at most `room` of them; returns their IDs and whether some were left out. */
  take(result: { links: EdgeRow[]; others: GraphRow[] }, stepKey: string, room: number) {
    const added: string[] = [];
    for (const other of result.others) {
      if (added.length >= room) return { added, cut: true };
      if (!this.add(other, stepKey)) continue;
      for (const link of result.links) if (link.fromId === other.id || link.toId === other.id) this.link(link);
      added.push(other.id);
    }
    return { added, cut: false };
  }

  /** Walks a step's hops from one node; returns the nodes the step itself reached. */
  async walk(stepKey: string, step: ExplorationState["steps"][string], fromId: string, room: number) {
    const plan = hops(step.path, this.nodes.get(this.byId.get(fromId) ?? "")?.type ?? "", step.direction);
    // The step's own nodes are the last required hop's; optional hops after it add context (a competitor's company).
    const leafHop = plan.findLastIndex(hop => !hop.optional);
    let frontier = [fromId], leaves: string[] = [], cut = false;
    for (const [index, hop] of plan.entries()) {
      const leaf = index === leafHop;
      const result = await this.hop(hop, frontier, leaf && step.type ? [step.type] : hop.to);
      // A hop whose edge types this Wiki lacks ends the walk; for a raw edge name that is an error.
      if (!result) {
        if (!hop.optional && !isNamed(step.path)) throw new Error(`This Wiki has no edge type ${step.path}`);
        break;
      }
      const taken = this.take(result, stepKey, leaf ? room : maxNodes);
      frontier = taken.added;
      if (leaf) ({ added: leaves, cut } = taken);
    }
    return { leaves, cut };
  }

  /** Pull requests of the Repository nodes at or one `source_in` hop from `fromId`, live from GitHub. */
  async pulls(stepKey: string, step: ExplorationState["steps"][string], fromId: string, room: number) {
    const read = this.providers.pullRequests;
    if (!read) throw new Error("Pull requests are read live from GitHub, which this request cannot reach");
    const repositories = await this.repositoriesOf(stepKey, step, fromId);
    const leaves: string[] = [];
    for (const { repository, key, pull } of await pullsIn(read, repositories, step.state ?? "open")) {
      const added = leaves.length < room && this.addPull(stepKey, repository, key, pull);
      if (added === false) return { leaves, cut: true };
      if (added) leaves.push(added);
    }
    return { leaves, cut: false };
  }

  /** The node itself when it is a Repository, else the repositories its project has code in. */
  private async repositoriesOf(stepKey: string, step: ExplorationState["steps"][string], fromId: string) {
    const from = this.nodes.get(this.byId.get(fromId) ?? "");
    if (from?.type === "Repository") return [from];
    const { leaves } = await this.walk(stepKey, { ...step, path: "repositories", type: undefined }, fromId, maxNodes);
    return leaves.map(id => this.nodes.get(this.byId.get(id) ?? "")).filter((node): node is PictureNode => !!node);
  }

  /** Adds one pull request under its repository: its key, null when hidden, false when the picture is full. */
  private addPull(stepKey: string, repository: PictureNode, key: string, pull: GithubPullRequest) {
    if (this.hidden.has(key)) return null;
    if (!this.nodes.has(key)) {
      if (this.nodes.size >= maxNodes) { this.truncated = true; return false; }
      this.nodes.set(key, { key, type: "PullRequest", title: `#${pull.number} ${pull.title}`, slug: null, id: key, step: stepKey, url: pull.url });
      this.byId.set(key, key);
    }
    this.edges.set(`${repository.key}|pull|${key}`, { from: repository.key, to: key, label: "pull request" });
    return key;
  }

  /** Staged records linked to the picture by a staged relationship, drawn as proposals until a member commits them. */
  async proposals(read: () => Promise<StagedOperation[]>) {
    const staged = (await read()).filter(item => item.operation.operation === "create");
    const nodes = new Map(staged.filter(item => item.operation.type === "graph-node").map(item => [`${item.batchId}:${item.ref}`, item]));
    const endpoint = (batchId: string, value: unknown) => {
      const id = String(value);
      if (id.startsWith("$")) return nodes.get(`${batchId}:${id}`);
      // Onto handles: a node slug works wherever an id does.
      return this.byId.has(id) ? id : [...this.nodes.values()].find(node => node.slug === id && !node.key.startsWith("proposed:"))?.id;
    };
    for (const edge of staged.filter(item => item.operation.type === "graph-edge")) {
      const attributes = (edge.operation.attributes ?? {}) as Record<string, unknown>;
      const ends = [endpoint(edge.batchId, attributes.fromId), endpoint(edge.batchId, attributes.toId)];
      // Only staged records that touch the picture: one end already in it, the other proposed.
      if (!ends.some(end => typeof end === "string") || ends.some(end => end === undefined)) continue;
      const [from, to] = ends.map(end => (typeof end === "string" ? this.byId.get(end) : this.propose(end as StagedOperation)));
      if (from && to) this.edges.set(`${from}|${String(attributes.typeId)}|${to}`, { from, to, label: this.typeLabel(attributes.typeId) ?? "related" });
    }
  }

  /** A type's name from its id, or the name itself when the operation used the type's handle. */
  private typeLabel(value: unknown) {
    const id = String(value);
    return this.typeName.get(id) ?? ([...this.typeName.values()].includes(id) ? id : undefined);
  }

  private propose(item: StagedOperation) {
    const attributes = (item.operation.attributes ?? {}) as Record<string, unknown>;
    const key = `proposed:${item.batchId}/${item.ref.replace(/^\$/, "")}`;
    if (!this.nodes.has(key) && this.nodes.size < maxNodes)
      this.nodes.set(key, { key, type: this.typeLabel(attributes.typeId) ?? "Entity", title: String(attributes.title ?? item.ref), slug: null, id: key, step: null, url: null, proposedIn: item.batchId });
    return this.nodes.has(key) ? key : undefined;
  }

  async step(stepKey: string, step: ExplorationState["steps"][string], reached: Map<string, string[]>): Promise<PictureStep> {
    const fanOut = step.from.startsWith("*");
    const fromIds = fanOut ? (reached.get(step.from.slice(1)) ?? []) : present([await this.idFor(step.from)]);
    if (!fanOut && !fromIds.length) throw new Error(`No node ${step.from}`);
    const limit = step.limit ?? defaultLimit, leaves = new Set<string>();
    const walk = step.path === "pullRequests" ? this.pulls.bind(this) : this.walk.bind(this);
    let cut = false;
    for (const fromId of fromIds) {
      if (!this.byId.has(fromId)) continue; // hidden, or beyond the picture's limit
      const walked = await walk(stepKey, step, fromId, limit - leaves.size);
      for (const id of walked.leaves) leaves.add(id);
      cut ||= walked.cut;
    }
    reached.set(stepKey, [...leaves]);
    return { key: stepKey, count: leaves.size, truncated: cut, error: null };
  }
}

/** Rebuild the picture an exploration describes from the Wiki's current records. */
export async function resolvePicture(source: GraphSource, state: ExplorationState, providers: PictureProviders = {}): Promise<Picture> {
  const picture = new PictureBuilder(source, await source.types(), new Set(Object.keys(state.hidden)), providers);
  const start = await picture.find(state.start.type, state.start.slug);
  if (!start) throw new Response(`No ${state.start.type} with slug ${state.start.slug} in this Wiki`, { status: 404 });
  picture.add(start, null);
  const reached = new Map<string, string[]>(), steps: PictureStep[] = [];
  for (const key of ordered(state.steps)) {
    try { steps.push(await picture.step(key, state.steps[key], reached)); }
    catch (error) {
      if (error instanceof Response) throw error;
      reached.set(key, []);
      steps.push({ key, count: 0, truncated: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (providers.proposals) await picture.proposals(providers.proposals);
  return { nodes: [...picture.nodes.values()], edges: [...picture.edges.values()], steps, truncated: picture.truncated };
}

/** The state a merge patch produces, its picture and the change line the page shows:
 * the nodes it added are the ones the page outlines. */
export async function changeExploration(source: GraphSource, before: ExplorationState | undefined, input: z.output<typeof mutateExplorationInput>,
  who: { by: string; via: string }, providers: PictureProviders = {}) {
  const parsed = explorationState.safeParse(applyMergePatch(before ?? {}, input.patch));
  if (!parsed.success) throw new Response(parsed.error.issues.map(issue => `${issue.path.join(".") || "patch"}: ${issue.message}`).join("; "), { status: 400 });
  const state = parsed.data;
  const picture = await resolvePicture(source, state, providers);
  const previous = before ? new Set((await resolvePicture(source, before, providers).catch(() => ({ nodes: [] as PictureNode[] }))).nodes.map(node => node.key)) : new Set<string>();
  const touched = picture.nodes.map(node => node.key).filter(key => !previous.has(key));
  return { state, picture, lastChange: { ...who, summary: input.summary ?? describe(before, state), nodes: touched.slice(0, 100) } };
}

function describe(before: ExplorationState | undefined, after: ExplorationState) {
  if (!before) return `Started from ${after.start.type} ${after.start.slug}`;
  const added = Object.keys(after.steps).filter(key => !before.steps[key]);
  const removed = Object.keys(before.steps).filter(key => !after.steps[key]);
  const hiddenNow = Object.keys(after.hidden).filter(key => !before.hidden[key]);
  const parts = [
    ...added.map(key => `opened ${after.steps[key].path}`),
    ...removed.map(key => `closed ${before.steps[key].path}`),
    ...(hiddenNow.length ? [`hid ${hiddenNow.length === 1 ? hiddenNow[0].replace(/^[^:]+:/, "") : `${hiddenNow.length} nodes`}`] : []),
  ];
  const text = parts.join(", ") || "changed the view";
  return text[0].toUpperCase() + text.slice(1);
}
