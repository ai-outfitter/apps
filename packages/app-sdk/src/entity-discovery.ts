import type { WorkflowHost } from "./workflow-host";

type Host = WorkflowHost<"interactive">;
type Selector = { installationId?: string; template?: string };
const discovery = new WeakMap<Host, Map<string, ReturnType<typeof read>>>();
const read = (host: Host, selector: Selector) => host.call("entities.types", selector);
const keyFor = (selector: Selector) => JSON.stringify([selector.installationId ?? null, selector.template ?? null]);

/** Share schema discovery only within this dispatch. Every record operation
 * still checks current authority; failures are retryable on the same host. */
export async function discoverEntityTypes(host: Host, selector: Selector = {}) {
  let cache = discovery.get(host);
  if (!cache) { cache = new Map(); discovery.set(host, cache); }
  const key = keyFor(selector);
  let pending = cache.get(key);
  if (!pending) {
    const current = cache;
    pending = read(host, selector).then(types => {
      // Reuse completed discovery for narrower collection opens. Never wait on
      // an unrelated in-flight catalog or cache records/authorization here.
      for (const installationId of new Set(types.map(type => type.installationId))) {
        const selected = types.filter(type => type.installationId === installationId);
        const target = keyFor({ installationId });
        if (!current.has(target)) current.set(target, Promise.resolve(selected));
      }
      return types;
    }).catch(error => { current.delete(key); throw error; });
    cache.set(key, pending);
  }
  return pending;
}
