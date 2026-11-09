import { z } from "zod";
import { requestIdentity, type AppIdentity } from "./server";
import { defineOperation, operationAPI, type AppOperation } from "./operations";

// Home cards are declarative summaries an app publishes for portal homepages
// (docs/home-cards.md). The app owns the data, authorization and mutations;
// the platform only dispatches the reserved route and renders these
// primitives. No app HTML, script, markdown or arbitrary URL is ever rendered.

export const homeCardVersion = 1 as const;
export const homeCardCapability = "home-cards.publish";
/** Reserved; reachable only through platform dispatch, never browser ingress. */
export const homeCardPath = "/api/internal/home-cards/v1";
export const homeCardSizes = ["small", "medium", "large"] as const;
export type HomeCardSize = (typeof homeCardSizes)[number];

export const homeCardLimits = {
  cards: 16,
  actionsPerCard: 8,
  nodes: 64,
  depth: 4,
  bodyNodes: 12,
  listItems: 20,
  itemChildren: 6,
  timelineGroups: 4,
  timelineProjects: 12,
  timelineItems: 40,
  title: 120,
  label: 80,
  text: 500,
  path: 512,
  actionInputBytes: 8 * 1024,
  actionInputDepth: 6,
  responseBytes: 256 * 1024,
  timeoutMs: 5000,
} as const;

const L = homeCardLimits;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const homeCardKey = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const homeCardItemId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const homeCardSize = z.enum(homeCardSizes);
const installationId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const title = z.string().min(1).max(L.title);
const label = z.string().min(1).max(L.label);
const text = z.string().max(L.text);
const tone = z.enum(["neutral", "info", "success", "warning", "danger"]);
export type HomeCardTone = z.infer<typeof tone>;

/** JSON depth, counting each array or object as one level. */
function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  return 1 + children.reduce<number>((deepest, child) => Math.max(deepest, jsonDepth(child)), 0);
}
export type HomeCardJSON = null | boolean | number | string | HomeCardJSON[] | { [key: string]: HomeCardJSON };
export const homeCardJSON = (z.json() as z.ZodType<HomeCardJSON>)
  .refine((value) => jsonDepth(value) <= L.actionInputDepth, "Action input is nested too deeply")
  .refine((value) => bytes(value) <= L.actionInputBytes, "Action input is too large");

/**
 * A path inside an installation: relative to its launch address, never a URL.
 * Rejected after decoding too, so `%2e%2e` cannot climb out of the app.
 */
export function safeHomeCardPath(path: string) {
  if (path.length < 1 || path.length > L.path || !path.startsWith("/") || path.startsWith("//")) return false;
  // Whitespace, controls and backslashes have no place in a route-safe path.
  if (path.includes("\\") || [...path].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)) return false;
  let candidate = path.split(/[?#]/, 1)[0];
  for (let round = 0; round < 3; round++) {
    if (candidate.startsWith("//") || candidate.includes("\\") || candidate.split("/").some((part) => part === "." || part === ".."))
      return false;
    let decoded: string;
    try { decoded = decodeURIComponent(candidate); } catch { return false; }
    if (decoded === candidate) return true;
    candidate = decoded;
  }
  return false;
}
const path = z.string().refine(safeHomeCardPath, "Unsafe home card path");
export const homeCardLinkTarget = z.union([
  z.strictObject({ path }),
  z.strictObject({ installationId, path }),
]);
export type HomeCardLinkTarget = z.infer<typeof homeCardLinkTarget>;
/** What the platform hands the portal after checking a link target. */
export type HomeCardResolvedLink = { installationId: string; href: string };

/** One node tree shape, parameterized by its link type: app-authored trees
 * carry targets, the platform's resolved trees carry checked addresses. */
export type HomeCardNodeOf<Link> =
  | { kind: "text"; text: string; tone?: HomeCardTone; emphasis?: "normal" | "strong" | "muted" }
  | { kind: "metric"; label: string; value: string | number; unit?: string; tone?: HomeCardTone; detail?: string }
  | { kind: "progress"; label: string; value: number; max: number; valueLabel?: string; tone?: HomeCardTone }
  | { kind: "status"; label: string; tone: HomeCardTone }
  | { kind: "link"; label: string; target: Link }
  | { kind: "notice"; tone: HomeCardTone; text: string; title?: string }
  | { kind: "empty"; text: string; link?: { kind: "link"; label: string; target: Link } }
  | HomeCardActionNode
  | { kind: "list"; items: HomeCardListItemOf<Link>[]; label?: string }
  | HomeCardTimelineNodeOf<Link>;
export type HomeCardActionNode = {
  kind: "action"; actionId: string; label: string; input?: HomeCardJSON; revision?: number;
  style?: "primary" | "secondary" | "danger"; confirm?: string;
};
export type HomeCardListItemOf<Link> = {
  id: string; title: string; subtitle?: string; meta?: string;
  status?: { label: string; tone: HomeCardTone }; link?: Link; children?: HomeCardNodeOf<Link>[];
};
/** Where a piece of work stands; the portal draws each as its own mark. */
export const homeCardTimelineStates = ["shipped", "in-progress", "agent-review", "planning", "needs-you"] as const;
export type HomeCardTimelineState = (typeof homeCardTimelineStates)[number];
/** The one verb an item's link offers: look at it, review it, or decide. */
export const homeCardTimelineVerbs = ["open", "review", "decide"] as const;
export type HomeCardTimelineVerb = (typeof homeCardTimelineVerbs)[number];
export type HomeCardTimelineItemOf<Link> = {
  id: string; title: string; state: HomeCardTimelineState; detail?: string; link?: Link; verb?: HomeCardTimelineVerb;
};
/** A status timeline: an optional summary, then day groups of projects (most
 * important first), each with its work items. Top level only. */
export type HomeCardTimelineNodeOf<Link> = {
  kind: "timeline"; summary?: string;
  groups: { label: string; projects: { id: string; title: string; items: HomeCardTimelineItemOf<Link>[] }[] }[];
};
export type HomeCardNode = HomeCardNodeOf<HomeCardLinkTarget>;
export type HomeCardListItem = HomeCardListItemOf<HomeCardLinkTarget>;
export type ResolvedHomeCardNode = HomeCardNodeOf<HomeCardResolvedLink>;
export type ResolvedHomeCardListItem = HomeCardListItemOf<HomeCardResolvedLink>;
export type HomeCardNodeKind = HomeCardNode["kind"];

const linkNode = z.strictObject({ kind: z.literal("link"), label, target: homeCardLinkTarget });
const actionNode = z.strictObject({
  kind: z.literal("action"), actionId: homeCardKey, label,
  input: homeCardJSON.optional(), revision: z.number().int().positive().optional(),
  style: z.enum(["primary", "secondary", "danger"]).optional(), confirm: z.string().min(1).max(200).optional(),
});
const leaves = [
  z.strictObject({ kind: z.literal("text"), text: text.min(1), tone: tone.optional(), emphasis: z.enum(["normal", "strong", "muted"]).optional() }),
  z.strictObject({ kind: z.literal("metric"), label, value: z.union([z.string().max(L.label), z.number().finite()]), unit: z.string().max(16).optional(), tone: tone.optional(), detail: z.string().max(L.label).optional() }),
  z.strictObject({ kind: z.literal("progress"), label, value: z.number().finite().nonnegative(), max: z.number().finite().positive(), valueLabel: z.string().max(L.label).optional(), tone: tone.optional() })
    .refine((node) => node.value <= node.max, "Progress exceeds its maximum"),
  z.strictObject({ kind: z.literal("status"), label, tone }),
  linkNode,
  z.strictObject({ kind: z.literal("notice"), tone, text: text.min(1), title: title.optional() }),
  z.strictObject({ kind: z.literal("empty"), text: text.min(1), link: linkNode.optional() }),
  actionNode,
] as const;

const unique = (keys: string[]) => new Set(keys).size === keys.length;
const uniqueIds = (rows: { id: string }[]) => unique(rows.map((row) => row.id));
const timelineItem = z.strictObject({
  id: homeCardItemId, title, state: z.enum(homeCardTimelineStates), detail: text.optional(),
  link: homeCardLinkTarget.optional(), verb: z.enum(homeCardTimelineVerbs).optional(),
});
const timelineNode = z.strictObject({
  kind: z.literal("timeline"), summary: text.min(1).optional(),
  groups: z.array(z.strictObject({
    label,
    projects: z.array(z.strictObject({
      id: homeCardItemId, title,
      items: z.array(timelineItem).max(L.timelineItems).refine(uniqueIds, "Duplicate timeline item"),
    })).max(L.timelineProjects).refine(uniqueIds, "Duplicate timeline project"),
  })).max(L.timelineGroups).refine((groups) => unique(groups.map((g) => g.label)), "Duplicate timeline group"),
}).refine((node) => node.groups.flatMap((g) => g.projects.flatMap((p) => p.items)).length <= L.timelineItems, "Too many timeline items");

// Built level by level, so depth is a structural limit (and the published JSON
// Schema has no recursion): lists are not offered at the deepest level.
function nodeAt(level: number): z.ZodType<HomeCardNode> {
  if (level >= L.depth) return z.discriminatedUnion("kind", [...leaves]) as unknown as z.ZodType<HomeCardNode>;
  const item = z.strictObject({
    id: homeCardItemId, title, subtitle: text.optional(), meta: z.string().max(L.label).optional(),
    status: z.strictObject({ label, tone }).optional(), link: homeCardLinkTarget.optional(),
    children: z.array(nodeAt(level + 1)).max(L.itemChildren).optional(),
  });
  const list = z.strictObject({
    kind: z.literal("list"), label: label.optional(),
    items: z.array(item).max(L.listItems).refine(uniqueIds, "Duplicate list item"),
  });
  // A timeline is a whole card body, never nested inside a list.
  return z.discriminatedUnion("kind", level === 1 ? [...leaves, list, timelineNode] : [...leaves, list]) as unknown as z.ZodType<HomeCardNode>;
}
export const homeCardNode = nodeAt(1);

/** Every node, depth first; the visitor sees each node once. */
export function walkHomeCardNodes<Link>(nodes: readonly HomeCardNodeOf<Link>[], visit: (node: HomeCardNodeOf<Link>) => void) {
  for (const node of nodes) {
    visit(node);
    if (node.kind === "list") for (const item of node.items) walkHomeCardNodes(item.children ?? [], visit);
  }
}
/** The link targets a node carries itself (not those of nested nodes). */
export function homeCardNodeLinks<Link>(node: HomeCardNodeOf<Link>): (Link | undefined)[] {
  switch (node.kind) {
    case "link": return [node.target];
    case "empty": return [node.link?.target];
    case "list": return node.items.map((item) => item.link);
    case "timeline": return node.groups.flatMap((group) => group.projects.flatMap((project) => project.items.map((item) => item.link)));
    default: return [];
  }
}
const countNodes = (nodes: readonly HomeCardNode[]) => { let count = 0; walkHomeCardNodes(nodes, () => count++); return count; };
export const homeCardBody = z.array(homeCardNode).max(L.bodyNodes)
  .refine((nodes) => countNodes(nodes) <= L.nodes, "Too many home card nodes");

export const homeCardDefinition = z.strictObject({
  cardId: homeCardKey,
  title,
  description: text.optional(),
  sizes: z.array(homeCardSize).min(1).max(homeCardSizes.length).refine((sizes) => new Set(sizes).size === sizes.length, "Duplicate size"),
  defaultSize: homeCardSize,
  actionIds: z.array(homeCardKey).max(L.actionsPerCard).refine((ids) => new Set(ids).size === ids.length, "Duplicate action"),
}).refine((card) => card.sizes.includes(card.defaultSize), "Default size must be supported");
export type HomeCardDefinition = z.infer<typeof homeCardDefinition>;
export const homeCardCatalog = z.strictObject({
  version: z.literal(homeCardVersion),
  cards: z.array(homeCardDefinition).max(L.cards).refine((cards) => new Set(cards.map((c) => c.cardId)).size === cards.length, "Duplicate card"),
});
export type HomeCardCatalog = z.infer<typeof homeCardCatalog>;

export const homeCardReadInput = z.strictObject({ cardId: homeCardKey, size: homeCardSize });
export type HomeCardReadInput = z.infer<typeof homeCardReadInput>;
export const homeCardUnavailableReasons = ["setup-required", "not-permitted", "not-found", "temporarily-unavailable"] as const;
export type HomeCardUnavailableReason = (typeof homeCardUnavailableReasons)[number];
const readDefinition = {
  title,
  sizes: z.array(homeCardSize).min(1).max(homeCardSizes.length),
  defaultSize: homeCardSize,
  actionIds: z.array(homeCardKey).max(L.actionsPerCard),
};
const unavailableResult = z.strictObject({
  version: z.literal(homeCardVersion), status: z.literal("unavailable"), cardId: homeCardKey, size: homeCardSize,
  ...readDefinition,
  reason: z.enum(homeCardUnavailableReasons), message: text.optional(),
});
export const homeCardReadResult = z.discriminatedUnion("status", [
  z.strictObject({
    version: z.literal(homeCardVersion), status: z.literal("ready"), cardId: homeCardKey, size: homeCardSize,
    ...readDefinition, body: homeCardBody, refreshedAt: z.iso.datetime({ offset: true }).optional(),
  }),
  unavailableResult,
]).superRefine((result, context) => {
  if (new Set(result.sizes).size !== result.sizes.length)
    context.addIssue({ code: "custom", path: ["sizes"], message: "Duplicate size" });
  if (!result.sizes.includes(result.defaultSize))
    context.addIssue({ code: "custom", path: ["defaultSize"], message: "Default size must be supported" });
  if (!result.sizes.includes(result.size))
    context.addIssue({ code: "custom", path: ["size"], message: "Effective size must be supported" });
  if (new Set(result.actionIds).size !== result.actionIds.length)
    context.addIssue({ code: "custom", path: ["actionIds"], message: "Duplicate action" });
});
export type HomeCardReadResult =
  | { version: 1; status: "ready"; cardId: string; size: HomeCardSize; title: string; sizes: HomeCardSize[]; defaultSize: HomeCardSize; actionIds: string[]; body: HomeCardNode[]; refreshedAt?: string }
  | { version: 1; status: "unavailable"; cardId: string; size: HomeCardSize; title: string; sizes: HomeCardSize[]; defaultSize: HomeCardSize; actionIds: string[]; reason: HomeCardUnavailableReason; message?: string };
export type ResolvedHomeCardReadResult =
  | (Omit<Extract<HomeCardReadResult, { status: "ready" }>, "body"> & { body: ResolvedHomeCardNode[] })
  | Extract<HomeCardReadResult, { status: "unavailable" }>;

export const homeCardActionInput = z.strictObject({
  cardId: homeCardKey,
  actionId: homeCardKey,
  input: homeCardJSON.default({}),
  revision: z.number().int().positive().optional(),
});
export type HomeCardActionInput = z.input<typeof homeCardActionInput>;
export const homeCardActionOutcomes = ["applied", "unchanged", "conflict"] as const;
export type HomeCardActionOutcome = (typeof homeCardActionOutcomes)[number];
export const homeCardActionResult = z.strictObject({
  version: z.literal(homeCardVersion),
  outcome: z.enum(homeCardActionOutcomes),
  message: text.optional(),
});
export type HomeCardActionResult = { version: 1; outcome: HomeCardActionOutcome; message?: string };

export type HomeCardReadContext = { identity: AppIdentity; size: HomeCardSize };
export type HomeCardActionContext = { identity: AppIdentity; actionId: string; input: HomeCardJSON; revision?: number };
export type HomeCardProvider = {
  cardId: string;
  title: string;
  description?: string;
  sizes: HomeCardSize[];
  defaultSize: HomeCardSize;
  /** Inline mutations by actionId. Each handler authorizes the specific
   * record for this viewer, checks its revision, and answers `unchanged`
   * when the record is already in the requested state. There is no implicit
   * editor gate: a member may act on their own records. */
  actions?: Record<string, (context: HomeCardActionContext) => Promise<Omit<HomeCardActionResult, "version"> | HomeCardActionResult>>;
  /** Additional app policy for seeing the card at all; defaults to any member. */
  can?: (identity: AppIdentity) => boolean;
  read(context: HomeCardReadContext): Promise<
    | { body: HomeCardNode[]; title?: string; refreshedAt?: string }
    | { unavailable: HomeCardUnavailableReason; message?: string }>;
};

const definitionOf = (card: HomeCardProvider): HomeCardDefinition => ({
  cardId: card.cardId, title: card.title, ...(card.description === undefined ? {} : { description: card.description }),
  sizes: card.sizes, defaultSize: card.defaultSize, actionIds: Object.keys(card.actions ?? {}),
});

/** Checks the static declaration once, when the app module loads. */
export function defineHomeCard(card: HomeCardProvider): HomeCardProvider {
  homeCardDefinition.parse(definitionOf(card));
  return card;
}

function capped<T>(value: T) {
  if (bytes(value) > L.responseBytes) throw new Response("Home card response is too large", { status: 502 });
  return value;
}

/** Home cards are one consumer of the generic app-operation dispatcher. */
export function homeCardOperations(cards: HomeCardProvider[]): Record<"catalog" | "read" | "action", AppOperation<AppIdentity>> {
  homeCardCatalog.parse({ version: homeCardVersion, cards: cards.map(definitionOf) });
  const find = (identity: AppIdentity, cardId: string) => {
    const card = cards.find((c) => c.cardId === cardId);
    if (!card) throw new Response("Home card not found", { status: 404 });
    if (!(card.can?.(identity) ?? true)) throw new Response("Home card not allowed", { status: 403 });
    return card;
  };
  return {
    catalog: defineOperation({
      method: "GET", input: z.strictObject({}), output: homeCardCatalog,
      authorize: (_identity: AppIdentity) => {},
      run: (identity) => ({ version: homeCardVersion, cards: cards.filter((c) => c.can?.(identity) ?? true).map(definitionOf) }),
    }),
    read: defineOperation({
      method: "POST", input: homeCardReadInput, output: homeCardReadResult, maxBytes: 4 * 1024,
      authorize: (identity: AppIdentity, input) => { find(identity, input.cardId); },
      run: async (identity, input) => {
        const card = find(identity, input.cardId);
        const size = card.sizes.includes(input.size) ? input.size : card.defaultSize;
        const metadata = {
          cardId: card.cardId,
          title: card.title,
          sizes: card.sizes,
          defaultSize: card.defaultSize,
          actionIds: Object.keys(card.actions ?? {}),
        };
        const result = await card.read({ identity, size });
        if ("unavailable" in result)
          return { version: homeCardVersion, status: "unavailable", size, ...metadata, reason: result.unavailable, ...(result.message ? { message: result.message } : {}) };
        const declared = new Set(Object.keys(card.actions ?? {}));
        walkHomeCardNodes(result.body, (node) => {
          if (node.kind === "action" && !declared.has(node.actionId)) throw new Response("Undeclared home card action", { status: 502 });
        });
        return capped({ version: homeCardVersion, status: "ready", size, ...metadata, ...result, title: result.title ?? card.title });
      },
    }),
    action: defineOperation({
      method: "POST", input: homeCardActionInput, output: homeCardActionResult, maxBytes: L.actionInputBytes + 1024,
      authorize: (identity: AppIdentity, input) => {
        if (!Object.hasOwn(find(identity, input.cardId).actions ?? {}, input.actionId)) throw new Response("Home card action not found", { status: 404 });
      },
      run: async (identity, input) => {
        const handler = find(identity, input.cardId).actions?.[input.actionId];
        if (!handler) throw new Response("Home card action not found", { status: 404 });
        const result = await handler({ identity, actionId: input.actionId, input: input.input, ...(input.revision === undefined ? {} : { revision: input.revision }) });
        return capped({ ...result, version: homeCardVersion });
      },
    }),
  };
}

/** Mount behind the outfitterApp() middleware at `${homeCardPath}/[operation]`. The
 * platform alone calls this reserved route, with the viewer's identity. */
export function homeCardAPI(request: Request, operation: string, cards: HomeCardProvider[]) {
  return operationAPI(request, operation, homeCardOperations(cards), () => requestIdentity(request));
}
