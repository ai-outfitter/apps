import { AsyncLocalStorage } from "node:async_hooks";

// Shared only within one request, never between installations or requests.
const sessions = new AsyncLocalStorage<{ binding: D1Database; session: D1DatabaseSession }>();

export function withDatabaseSession<T>(binding: D1Database | undefined, work: () => T): T {
  if (!binding) return work();
  const session = binding.withSession("first-primary");
  return sessions.run({ binding, session }, work);
}

/** Outside request middleware, background jobs keep the primary binding. */
export function requestDatabase(binding: D1Database | undefined): D1Database | D1DatabaseSession | undefined {
  const current = sessions.getStore();
  return current?.binding === binding ? current?.session : binding;
}
