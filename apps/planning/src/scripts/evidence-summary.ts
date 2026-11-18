import { onPageLoad } from "@ai-outfitter/ui/page";
onPageLoad(() => {
  if (import.meta.env.OUTFITTER_APP_MODE === "demo") return;
  const abort = new AbortController();
  const queue: HTMLElement[] = [];
  let running = 0;
  async function run() {
    if (running >= 3 || !queue.length || abort.signal.aborted) return;
    running++;
    const element = queue.shift()!;
    try {
      const response = await fetch(
        `${element.dataset.endpoint}?projectId=${encodeURIComponent(element.dataset.evidenceSummary!)}`,
        { signal: abort.signal },
      );
      if (!response.ok) throw new Error("Evidence unavailable");
      const result = await response.json();
      const latest = result.items?.[0];
      element.textContent = latest?.mediaCount > 0
        ? `${latest.title} · ${latest.mediaCount} captures${latest.capturedAt ? ` · ${latest.capturedAt.slice(0, 10)}` : ""}`
        : "No visual evidence captured";
    } catch {
      if (!abort.signal.aborted)
        element.textContent = "Evidence status unavailable";
    } finally {
      running--;
      void run();
    }
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries)
      if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        queue.push(entry.target as HTMLElement);
        void run();
      }
  });
  document
    .querySelectorAll<HTMLElement>("[data-evidence-summary]")
    .forEach((element) => observer.observe(element));
  document.addEventListener(
    "astro:before-swap",
    () => {
      abort.abort();
      observer.disconnect();
    },
    { once: true },
  );
});
