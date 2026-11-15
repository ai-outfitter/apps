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
        const provider = candidates[0];
        // Known IDs asked for in the same tick are read together: one indexed list per 100 IDs.
        let pending: Map<string, ((record: ReturnType<typeof collectionRecord> | undefined) => void)[]> | null = null;
        let failures: ((error: unknown) => void)[] = [];
        const flush = async () => {
          const waiting = pending as NonNullable<typeof pending>;
          const rejecters = failures;
          pending = null; failures = [];
          try {
            const ids = [...waiting.keys()];
            const found = new Map<string, ReturnType<typeof collectionRecord>>();
            for (let index = 0; index < ids.length; index += 100) {
              const { records } = await host.call("entities.list", { installationId: provider.installationId, type: provider.type, ids: ids.slice(index, index + 100), limit: 100 });
              for (const record of records) found.set(record.ref.id, collectionRecord(record));
            }
            for (const [id, resolvers] of waiting) for (const resolve of resolvers) resolve(found.get(id));
          } catch (error) { for (const reject of rejecters) reject(error); }
        };
        const collection = {
          /** The record with this ID, or undefined; concurrent loads share one batched read. */
          load(id: string) {
            return new Promise<ReturnType<typeof collectionRecord> | undefined>((resolve, reject) => {
              if (!pending) { pending = new Map(); (typeof setImmediate === "function" ? setImmediate : setTimeout)(() => void flush()); }
              pending.set(id, [...pending.get(id) ?? [], resolve]);
              failures.push(reject);
            });
          },
          async get(id: string) {
            const record = await host.call("entities.get", { installationId: provider.installationId, type: provider.type, id });
            return collectionRecord(record);
          },
          /** One page; continue with `after: pageInfo.endCursor` while `pageInfo.hasNextPage`. */
          async list(options: ListOptions = {}) {
            const { records, pageInfo } = await host.call("entities.list", {
              installationId: provider.installationId, type: provider.type,
              ...(options.where === undefined ? {} : { filter: options.where as EntityRecord["attributes"] }),
              ...(options.select === undefined ? {} : { select: options.select }),
              ...(options.order === undefined ? {} : { order: options.order }),
              ...(options.ids === undefined ? {} : { ids: options.ids }),
              ...(options.search === undefined ? {} : { search: options.search }),
              ...(options.after === undefined ? {} : { after: options.after }),
              limit: options.limit ?? 50,
            });
            return { records: records.map(collectionRecord), pageInfo };
          },
          /** Every matching record, page by page, up to `max` (default 10,000). */
          async all(options: Omit<ListOptions, "after" | "limit"> = {}, max = 10_000) {
            return (await listEntities(host, {
              installationId: provider.installationId, type: provider.type,
              ...(options.where === undefined ? {} : { filter: options.where }),
              ...(options.select === undefined ? {} : { select: options.select }),
              ...(options.order === undefined ? {} : { order: options.order }),
              ...(options.ids === undefined ? {} : { ids: options.ids }),
              ...(options.search === undefined ? {} : { search: options.search }),
            }, max)).map(collectionRecord);
          },
        };
        return collection;
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
