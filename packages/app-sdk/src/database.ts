import type { WorkflowHost } from "./workflow-host";
import type { EntityRecord } from "./entities";
import { discoverEntityTypes } from "./entity-discovery";

type Host = WorkflowHost<"interactive">;
type ListOptions = {
  where?: Record<string, unknown>;
  select?: string[];
  order?: { field: string; direction: "asc" | "desc" };
  ids?: string[];
  search?: string;
  /** The previous page's `endCursor`. */
  after?: string;
  limit?: number;
};

const collectionRecord = (record: EntityRecord) => ({
  ...record.attributes, id: record.ref.id, title: record.title, ref: record.ref,
  revision: record.revision, references: record.references, attributes: record.attributes,
});
type EntityListInput = { installationId: string; type: string; filter?: Record<string, unknown>; select?: string[]; order?: { field: string; direction: "asc" | "desc" }; ids?: string[]; search?: string };
/** Every record an entity query matches, read page by page through the host in the owning app's
 * database, up to `max` records (default 10,000). */
export async function listEntities(host: Host, input: EntityListInput, max = 10_000): Promise<EntityRecord[]> {
  const records: EntityRecord[] = [];
  let after: string | undefined;
  do {
    const page = await host.call("entities.list", { ...input, filter: input.filter as EntityRecord["attributes"] | undefined, limit: 100, ...(after ? { after } : {}) });
    records.push(...page.records);
    if (records.length > max) throw new Response("The records exceed the read limit; narrow the filter", { status: 413 });
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
  } while (after);
  return records;
}

/** An app template's slug, as the workflow host's entity discovery accepts it. */
const templateSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const contexts = new WeakMap<Host, ReturnType<typeof createAppDataContext>>();

type Record_ = ReturnType<typeof collectionRecord>;
/** The entities.list input for `options`, leaving out what was not asked for. */
function listInput(provider: { installationId: string; type: string }, { where, after: _after, limit: _limit, ...options }: ListOptions) {
  const input: EntityListInput = { installationId: provider.installationId, type: provider.type };
  if (where !== undefined) input.filter = where;
  for (const [key, value] of Object.entries(options)) if (value !== undefined) Object.assign(input, { [key]: value });
  return input;
}
/** Known IDs asked for in the same tick, read together: one indexed list per 100 IDs. */
function batchedLoads(host: Host, provider: { installationId: string; type: string }) {
  let pending: Map<string, { resolve: (record: Record_ | undefined) => void; reject: (error: unknown) => void }[]> | null = null;
  const read = async (ids: string[]) => {
    const found = new Map<string, Record_>();
    for (let index = 0; index < ids.length; index += 100) {
      const { records } = await host.call("entities.list", { installationId: provider.installationId, type: provider.type, ids: ids.slice(index, index + 100), limit: 100 });
      for (const record of records) found.set(record.ref.id, collectionRecord(record));
    }
    return found;
  };
  const flush = () => {
    const waiting = pending as NonNullable<typeof pending>;
    pending = null;
    read([...waiting.keys()]).then(
      found => { for (const [id, callers] of waiting) for (const { resolve } of callers) resolve(found.get(id)); },
      error => { for (const callers of waiting.values()) for (const { reject } of callers) reject(error); },
    );
  };
  return (id: string) => new Promise<Record_ | undefined>((resolve, reject) => {
    if (!pending) { pending = new Map(); (typeof setImmediate === "function" ? setImmediate : setTimeout)(flush); }
    pending.set(id, [...pending.get(id) ?? [], { resolve, reject }]);
  });
}
function entityCollection(host: Host, provider: { installationId: string; type: string }) {
  return {
    /** The record with this ID, or undefined; concurrent loads share one batched read. */
    load: batchedLoads(host, provider),
    async get(id: string) {
      return collectionRecord(await host.call("entities.get", { installationId: provider.installationId, type: provider.type, id }));
    },
    /** One page; continue with `after: pageInfo.endCursor` while `pageInfo.hasNextPage`. */
    async list(options: ListOptions = {}) {
      const { records, pageInfo } = await host.call("entities.list", {
        ...listInput(provider, options), filter: options.where as EntityRecord["attributes"] | undefined,
        ...(options.after ? { after: options.after } : {}), limit: options.limit ?? 50,
      });
      return { records: records.map(collectionRecord), pageInfo };
    },
    /** Every matching record, page by page, up to `max` (default 10,000). */
    async all(options: Omit<ListOptions, "after" | "limit"> = {}, max = 10_000) {
      return (await listEntities(host, listInput(provider, options), max)).map(collectionRecord);
    },
  };
}

/** A request-scoped facade over entities; arguments never grant owner access. */
export function appDataContext(host: Host) {
  const existing = contexts.get(host);
  if (existing) return existing;
  const context = createAppDataContext(host);
  contexts.set(host, context);
  return context;
}

function createAppDataContext(host: Host) {
  async function resolve(matches: Awaited<ReturnType<typeof discoverEntityTypes>>) {
    const installations = new Set(matches.map(item => item.installationId));
    if (installations.size !== 1) throw new Response("App database unavailable or ambiguous", { status: 409 });
    return {
      installationId: matches[0].installationId,
      hostname: matches[0].hostname ?? null,
      /** Its address segment (`/apps/<slug>/` for a person's app); an unrenamed app's is its template. */
      slug: matches[0].slug ?? matches[0].template ?? "",
      collection(name: string) {
        const candidates = matches.filter(item => item.collection === name);
        if (candidates.length !== 1) throw new Response("Collection unavailable or ambiguous", { status: 404 });
        return entityCollection(host, candidates[0]);
      },
    };
  }
  return { apps: {
    async database(template: string) {
      // The host takes only a template slug ("wiki-map"); say so instead of an opaque refusal.
      if (!templateSlug.test(template)) throw new Response(`Invalid app template "${template.slice(0, 128)}"; use its slug, such as "wiki-map"`, { status: 400 });
      return resolve((await discoverEntityTypes(host, { template })).filter(item => item.template === template && item.collection));
    },
    async installation(installationId: string) {
      return resolve((await discoverEntityTypes(host, { installationId })).filter(item => item.installationId === installationId && item.collection));
    },
  } };
}
