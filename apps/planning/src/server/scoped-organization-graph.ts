import type { appDataContext } from "@ai-outfitter/app-sdk/database";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import {
  requireOrganization,
  type AppIdentity,
} from "@ai-outfitter/app-sdk/server";
import { resolveOrganizationPattern } from "./organization-exploration";

type Context = ReturnType<typeof appDataContext>;
type Database = Awaited<ReturnType<Context["apps"]["database"]>>;
const active = (record: EntityRecord) =>
  !record.attributes.archived && !record.attributes.archivedAt;
const nodeFields = [
  "id",
  "typeId",
  "title",
  "slug",
  "summary",
  "body",
  "properties",
  "archived",
];

/** Read only the saved overview's bounded neighborhoods through published collections. */
export async function readScopedOrganizationGraph(
  context: Context,
  identity: AppIdentity,
) {
  const who = requireOrganization(identity);
  const database = await context.apps.database("wiki-map");
  async function list(
    collection: ReturnType<Database["collection"]>,
    options: Parameters<ReturnType<Database["collection"]>["list"]>[0],
  ) {
    const result: EntityRecord[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await collection.list({ ...options, offset, limit: 100 });
      result.push(...page);
      if (result.length > 10000)
        throw new Response("Selected graph exceeds its read bound", {
          status: 413,
        });
      if (page.length < 100) return result;
    }
  }
  // Types are small registry metadata; retain archived definitions to validate saved rules.
  const types = await list(database.collection("types"), {
    select: ["id", "name", "category", "title", "archived"],
  });
  const organizationTypes = types.filter(
    (t) =>
      active(t) &&
      t.attributes.name === "Organization" &&
      t.attributes.category === "node",
  );
  // Find bindings without downloading every company's authored body. Only exact
  // binding candidates are hydrated and counted as loaded traversal records.
  const [organizationLookup, lensCandidates] = await Promise.all([
    Promise.all(
      organizationTypes.map((t) =>
        list(database.collection("nodes"), {
          where: { typeId: t.ref.id, archived: false },
          select: ["id", "typeId", "title", "properties", "archived"],
        }),
      ),
    ).then((pages) => pages.flat()),
    list(database.collection("nodes"), {
      where: { slug: "organization-overview", archived: false },
      select: nodeFields,
    }),
  ]);
  const nodes = new Map<string, EntityRecord>();
  const edges = new Map<string, EntityRecord>();
  let truncated = false;
  const activeTypeIds = new Set(types.filter(active).map((t) => t.ref.id));
  const typeName = (record: EntityRecord) =>
    types.find((t) => t.ref.id === record.attributes.typeId)?.attributes.name;
  const eligible = (record: EntityRecord) => {
    if (!active(record) || !activeTypeIds.has(String(record.attributes.typeId)))
      return false;
    try {
      return (
        JSON.parse(String(record.attributes.body ?? "{}"))?.status !== "retired"
      );
    } catch {
      return true;
    }
  };
  const boundOrganizations = organizationLookup.filter(
    (n) =>
      (n.attributes.properties as Record<string, unknown> | undefined)
        ?.organization_id === who.organizationId,
  );
  const anchors: EntityRecord[] = [];
  for (let offset = 0; offset < boundOrganizations.length; offset += 8) {
    const records = await Promise.all(boundOrganizations.slice(offset, offset + 8).map(
      (record) => database.collection("nodes").get(record.ref.id),
    ));
    anchors.push(...records.filter(eligible));
  }
  const lenses = lensCandidates.filter(
    (record) => eligible(record) && typeName(record) === "KnowledgeGraph",
  );
  for (const record of [...anchors, ...lenses]) nodes.set(record.ref.id, record);
  const boundIds = new Set(boundOrganizations.map((record) => record.ref.id));
  const result = () => ({
    truncated,
    wiki: {
      installationId: database.installationId,
      hostname: database.hostname,
      slug: database.slug,
      writable: false,
    },
    types,
    // Lightweight unbound organizations remain available as setup choices, but
    // never occupy the traversal's loaded-node budget. Retired bindings stay out.
    nodes: [...new Map([
      ...organizationLookup.filter((record) => !boundIds.has(record.ref.id)),
      ...nodes.values(),
    ].map((record) => [record.ref.id, record])).values()],
    edges: [...edges.values()],
  });
  if (anchors.length !== 1 || lenses.length !== 1) return result();
  let pattern: ReturnType<typeof resolveOrganizationPattern>;
  try {
    pattern = resolveOrganizationPattern(types, anchors[0], lenses[0]);
  } catch {
    return result();
  } // The shared selector returns the precise setup gap.
  const pending = new Map<string, Promise<EntityRecord | undefined>>();
  async function node(id: string) {
    if (nodes.has(id))
      return eligible(nodes.get(id)!) ? nodes.get(id) : undefined;
    if (nodes.size >= 1000) {
      truncated = true;
      return undefined;
    }
    let read = pending.get(id);
    if (!read) {
      read = database
        .collection("nodes")
        .get(id)
        .then((record) => {
          if (!eligible(record)) return undefined;
          if (nodes.size >= 1000) {
            truncated = true;
            return undefined;
          }
          nodes.set(id, record);
          return record;
        })
        .catch((error) => {
          if (error instanceof Response && error.status === 404)
            return undefined;
          throw error;
        });
      pending.set(id, read);
    }
    return read;
  }
  const selected = new Set([anchors[0].ref.id]);
  const queue = [{ record: anchors[0], depth: 0 }];
  const provenanceQueued = new Set<string>();
  const adjacency = new Map<string, ReturnType<typeof list>>();
  type Current = (typeof queue)[number];
  type Rule = (typeof pattern.rules)[number];
  const productTypes = ["Product", "SoftwareProduct"];
  function sourceMatches(current: Current, edge: EntityRecord, rule: Rule) {
    const incoming = rule.direction === "incoming";
    const sourceId = incoming ? edge.attributes.toId : edge.attributes.fromId;
    const sourceType = incoming ? rule.toType : rule.fromType;
    return current.depth < pattern.depth &&
      rule.typeId === edge.attributes.typeId &&
      sourceId === current.record.ref.id &&
      (!sourceType || sourceType === current.record.attributes.typeId);
  }
  function projectProvenanceTargets(edgeType: string) {
    const targets: Record<string, string[]> = {
      produces: productTypes, part_of: [...productTypes, "Organization"],
    };
    return targets[edgeType] ?? [];
  }
  function provenanceTypes(current: Current, edge: EntityRecord): string[] {
    const currentType = String(typeName(current.record));
    const edgeType = String(typeName(edge));
    if (currentType === "Project" && edge.attributes.fromId === current.record.ref.id)
      return projectProvenanceTargets(edgeType);
    if (!productTypes.includes(currentType)) return [];
    const outgoing = edge.attributes.fromId === current.record.ref.id;
    const incoming = edge.attributes.toId === current.record.ref.id;
    if (outgoing && edgeType === "developed_by") return ["Organization"];
    if (!incoming) return [];
    const targets: Record<string, string[]> = {
      packages_product: ["Offering"], produces: ["Project"], part_of: ["Project"],
    };
    return targets[edgeType] ?? [];
  }
  function otherEndpoint(current: Current, edge: EntityRecord) {
    return String(edge.attributes.fromId === current.record.ref.id
      ? edge.attributes.toId : edge.attributes.fromId);
  }
  function matchesLoadedTarget(current: Current, edge: EntityRecord) {
    const target = nodes.get(otherEndpoint(current, edge));
    if (!target) return false;
    if (provenanceTypes(current, edge).includes(String(typeName(target)))) return true;
    return pattern.rules.some((rule) => {
      if (!sourceMatches(current, edge, rule)) return false;
      const targetType = rule.direction === "incoming" ? rule.fromType : rule.toType;
      return !targetType || target.attributes.typeId === targetType;
    });
  }
  function canExpand(current: Current) {
    const name = String(typeName(current.record));
    if (name === "Project" || productTypes.includes(name)) return true;
    return current.depth < pattern.depth && pattern.rules.some((rule) => {
      const sourceType = rule.direction === "incoming" ? rule.toType : rule.fromType;
      return !sourceType || sourceType === current.record.attributes.typeId;
    });
  }
  async function readNeighborhood(current: Current) {
    if (!canExpand(current)) return [];
    let incident = adjacency.get(current.record.ref.id);
    if (!incident) {
      incident = list(database.collection("edges"), {
        where: { nodeId: current.record.ref.id, archived: false },
        select: ["id", "typeId", "fromId", "toId", "properties", "archived"],
      });
      adjacency.set(current.record.ref.id, incident);
    }
    const candidates = (await incident).filter((edge) =>
      provenanceTypes(current, edge).length > 0 ||
      pattern.rules.some((rule) => sourceMatches(current, edge, rule)),
    );
    const endpointIds = [...new Set(candidates.map((edge) => otherEndpoint(current, edge)))];
    // Fetch only the opposite endpoint of a direction/type-matching rule. Nodes
    // at the depth limit supply solely the required project/product provenance.
    for (let offset = 0; offset < endpointIds.length; offset += 8)
      await Promise.all(endpointIds.slice(offset, offset + 8).map(node));
    const relevant = candidates.filter((edge) => matchesLoadedTarget(current, edge));
    if (productTypes.includes(String(typeName(current.record))))
      await readOfferingProviders(current, relevant);
    return relevant;
  }
  async function readOfferingProviders(
    current: (typeof queue)[number],
    relevant: EntityRecord[],
  ) {
    const packages = types.find(
      (t) =>
        active(t) &&
        t.attributes.name === "packages_product" &&
        t.attributes.category === "edge",
    );
    const offeredBy = types.find(
      (t) =>
        active(t) &&
        t.attributes.name === "offered_by" &&
        t.attributes.category === "edge",
    );
    if (packages && offeredBy)
      for (const edge of relevant) {
        const offering = nodes.get(String(edge.attributes.fromId));
        if (
          edge.attributes.typeId !== packages.ref.id ||
          edge.attributes.toId !== current.record.ref.id ||
          !offering ||
          typeName(offering) !== "Offering"
        )
          continue;
        const providers = await list(database.collection("edges"), {
          where: {
            typeId: offeredBy.ref.id,
            fromId: offering.ref.id,
            archived: false,
          },
          select: ["id", "typeId", "fromId", "toId", "properties", "archived"],
        });
        await retainProviders(providers, offering, offeredBy);
      }
  }
  async function retainProviders(
    providers: EntityRecord[],
    offering: EntityRecord,
    offeredBy: EntityRecord,
  ) {
    for (const provider of providers) {
      if (
        provider.attributes.fromId !== offering.ref.id ||
        provider.attributes.typeId !== offeredBy.ref.id
      )
        continue;
      if (await node(String(provider.attributes.toId)))
        edges.set(provider.ref.id, provider);
    }
  }
  function retainEdge(current: (typeof queue)[number], edge: EntityRecord) {
    const from = nodes.get(String(edge.attributes.fromId));
    const to = nodes.get(String(edge.attributes.toId));
    if (!from || !to || !active(from) || !active(to)) return;
    edges.set(edge.ref.id, edge);
    if (edges.size > 10000)
      throw new Response("Selected graph exceeds 10000 relationships", {
        status: 413,
      });
    if (
      typeName(current.record) === "Project" &&
      typeName(edge) === "produces" &&
      from.ref.id === current.record.ref.id &&
      ["Product", "SoftwareProduct"].includes(String(typeName(to))) &&
      !selected.has(to.ref.id) &&
      !provenanceQueued.has(to.ref.id)
    ) {
      provenanceQueued.add(to.ref.id);
      queue.push({ record: to, depth: pattern.depth });
    }
    if (current.depth >= pattern.depth) return;
    for (const rule of pattern.rules) followRule(current, edge, from, to, rule);
  }
  function followRule(
    current: (typeof queue)[number],
    edge: EntityRecord,
    from: EntityRecord,
    to: EntityRecord,
    rule: (typeof pattern.rules)[number],
  ) {
    if (
      rule.typeId !== edge.attributes.typeId ||
      (rule.fromType && from.attributes.typeId !== rule.fromType) ||
      (rule.toType && to.attributes.typeId !== rule.toType)
    )
      return;
    const source = rule.direction === "incoming" ? to : from;
    const target = rule.direction === "incoming" ? from : to;
    if (source.ref.id !== current.record.ref.id || selected.has(target.ref.id))
      return;
    if (selected.size >= 200) {
      truncated = true;
      return;
    }
    selected.add(target.ref.id);
    queue.push({ record: target, depth: current.depth + 1 });
  }
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const relevant = await readNeighborhood(current);
    for (const edge of relevant) retainEdge(current, edge);
  }

  return result();
}
