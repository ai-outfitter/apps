// Page scripts for apps whose layout turns on client-side navigation.

const routed = () => Boolean(document.querySelector('meta[name="astro-view-transitions-enabled"]'));

/**
 * Runs `setup` on every page view: now, for the page the script was first
 * evaluated on, and again after each client-side navigation. A bundled script
 * runs only once per visit to the app, so page work must live here. The signal
 * aborts when the next page swaps in: pass it to listeners on `document` or
 * `window`, timers and fetches, and check it after awaits, so late work stops.
 */
export function onPageLoad(setup: (signal: AbortSignal) => void | Promise<void>) {
  let controller: AbortController | undefined;
  const run = () => {
    controller?.abort();
    controller = new AbortController();
    void setup(controller.signal);
  };
  if (routed()) {
    // Only page loads that follow a swap seen here: a module first evaluated
    // during a swap runs below, on the new page, and not again for that swap.
    let swapped = false;
    document.addEventListener("astro:before-swap", () => controller?.abort());
    document.addEventListener("astro:after-swap", () => { swapped = true; });
    document.addEventListener("astro:page-load", () => {
      if (!swapped) return;
      swapped = false;
      run();
    });
  }
  run();
}
