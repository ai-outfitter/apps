import type { WorkflowHost } from "./workflow-host";
import type { EntityRecord } from "./entities";
import { discoverEntityTypes } from "./entity-discovery";

type Host = WorkflowHost<"interactive">;
type ListOptions = {
  where?: Record<string, unknown>;
  select?: string[];
  order?: { field: string; direction: "asc" | "desc" };
  offset?: number;
  limit?: number;
};

const collectionRecord = (record: EntityRecord) => ({
  ...record.attributes, id: record.ref.id, title: record.title, ref: record.ref,
  revision: record.revision, references: record.references, attributes: record.attributes,
});
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
        return {
          async get(id: string) {
            const record = await host.call("entities.get", { installationId: provider.installationId, type: provider.type, id });
            return collectionRecord(record);
          },
          async list(options: ListOptions = {}) {
            const records = await host.call("entities.list", {
              installationId: provider.installationId, type: provider.type,
              ...(options.where === undefined ? {} : { filter: options.where as EntityRecord["attributes"] }),
              ...(options.select === undefined ? {} : { select: options.select }),
              ...(options.order === undefined ? {} : { order: options.order }),
              offset: options.offset ?? 0, limit: options.limit ?? 50,
            });
            return records.map(collectionRecord);
          },
        };
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
