// Collects the keys asked for in one tick and answers them with one call. No imports, so any
// module, server or workflow, can use it.
const later = (run: () => void) => (typeof setImmediate === "function" ? setImmediate(run) : setTimeout(run, 0));

/** `load(key)` joins the batch of its tick; `run` answers the whole batch, and a key it leaves out resolves to
 * `missing`. Answers are remembered for the loader's life (a failed batch is forgotten) unless `cache` is false,
 * where each tick reads again and only loads of the same key in one tick share an answer. */
export function batch<V>(run: (keys: string[]) => Promise<Map<string, V>>, missing: V, { cache: remember = true }: { cache?: boolean } = {}) {
  type Waiting = { promise: Promise<V>; resolve: (value: V) => void; reject: (error: unknown) => void };
  const cache = new Map<string, Promise<V>>();
  let pending: Map<string, Waiting> | null = null;
  const flush = async () => {
    const waiting = pending as NonNullable<typeof pending>;
    pending = null;
    try {
      const found = await run([...waiting.keys()]);
      for (const [key, { resolve }] of waiting) resolve(found.get(key) ?? missing);
    } catch (error) {
      for (const [key, { reject }] of waiting) { cache.delete(key); reject(error); }
    }
  };
  return {
    load(key: string) {
      const known = cache.get(key) ?? pending?.get(key)?.promise;
      if (known) return known;
      if (!pending) { pending = new Map(); later(() => void flush()); }
      const waiting = {} as Waiting;
      waiting.promise = new Promise<V>((resolve, reject) => Object.assign(waiting, { resolve, reject }));
      pending.set(key, waiting);
      if (remember) cache.set(key, waiting.promise);
      return waiting.promise;
    },
    prime(key: string, value: V) { if (remember && !cache.has(key)) cache.set(key, Promise.resolve(value)); },
  };
}
