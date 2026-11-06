// Live page data: polling that follows the page's visibility, and the
// refresh a pull-down in the installed app asks for. No app API or router.

type Refresh = () => unknown | Promise<unknown>;

const handlers = new Set<Refresh>();
let running: Promise<void> | undefined;

/**
 * Registers what the page does when the member asks for fresh data, such as a
 * pull-down in the installed app. Pages without a handler reload instead. The
 * handler is removed when `signal` aborts, so pass the `onPageLoad` signal.
 */
export function onRefresh(signal: AbortSignal, refresh: Refresh) {
  if (signal.aborted) return;
  handlers.add(refresh);
  signal.addEventListener("abort", () => handlers.delete(refresh), { once: true });
}

/**
 * Refreshes the page now: runs every registered handler, or reloads the page
 * when none is registered. There is no cooldown. A request made while a
 * refresh is still running joins it rather than starting a second one.
 */
export function refreshPage(): Promise<void> {
  if (running) return running;
  if (!handlers.size) {
    location.reload();
    return Promise.resolve();
  }
  running = Promise.allSettled([...handlers].map(async (refresh) => refresh()))
    .then(() => undefined)
    .finally(() => { running = undefined; });
  return running;
}

export type LivePollOptions = {
  /** Milliseconds between refreshes while the page is visible. Default 10 seconds. */
  every?: number;
  /** Stops polling once it returns true, for example when a run has finished. Checked after each refresh. */
  until?: () => boolean;
  /** Skips one tick while it returns true, for example while the member is using the list. */
  skip?: () => boolean;
  /** Longest wait after repeated failures. Default 60 seconds. */
  maxBackoff?: number;
  /** Refresh once immediately. Default false: the page has usually just loaded its data. */
  immediate?: boolean;
  /** Called with each failure; the poll keeps going with a longer wait. */
  onError?: (error: unknown) => void;
};

/**
 * Keeps a page's data current. It refreshes every `every` milliseconds while
 * the page is visible, pauses while it is hidden, and refreshes at once when
 * the page becomes visible again or the device comes back online. Failures
 * double the wait up to `maxBackoff`. It also registers `refresh` with
 * `onRefresh`, so a pull-down refreshes the same data. Everything stops when
 * `signal` aborts. Returns `now()`, which refreshes immediately and restarts
 * polling if `until` had stopped it.
 */
export function livePoll(signal: AbortSignal, refresh: Refresh, options: LivePollOptions = {}) {
  const every = Math.max(1000, options.every ?? 10_000);
  const maxBackoff = Math.max(every, options.maxBackoff ?? 60_000);
  let wait = every;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const visible = () => document.visibilityState !== "hidden";
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (signal.aborted || stopped || !visible()) return;
    timer = setTimeout(() => void tick(), wait);
  };
  const run = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await refresh();
        wait = every;
      } catch (error) {
        if (signal.aborted) return;
        wait = Math.min(maxBackoff, wait * 2);
        options.onError?.(error);
      }
      if (options.until?.()) stopped = true;
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  async function tick() {
    if (signal.aborted || stopped) return;
    if (!options.skip?.()) await run();
    schedule();
  }
  const now = async () => {
    stopped = false;
    clearTimeout(timer);
    await run();
    schedule();
  };
  const resume = () => {
    if (!visible()) return clearTimeout(timer);
    if (!stopped) void now();
  };
  document.addEventListener("visibilitychange", resume, { signal });
  window.addEventListener("online", resume, { signal });
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  onRefresh(signal, now);
  if (options.until?.()) stopped = true;
  if (options.immediate) void now();
  else schedule();
  return { now };
}
