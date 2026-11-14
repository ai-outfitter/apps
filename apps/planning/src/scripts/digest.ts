import { livePoll } from "@ai-outfitter/ui/live";
import { onPageLoad } from "@ai-outfitter/ui/page";

// The Daily digest page: start a digest (the platform's project-digest task), or
// turn the morning digest on or off, through /api/apps/planning/digests. While a
// digest run is running, the page polls the platform's run record and reloads
// once it finishes, so the server renders the new digest.
// The read-only demo makes no operational calls: the build drops this whole branch.
if (import.meta.env.OUTFITTER_APP_MODE !== "demo") {
onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>("#project-digest");
  if (!root) return;
  const projectId = root.dataset.projectId ?? "";
  const notice = root.querySelector<HTMLElement>("#digest-notice");
  if (!notice) return;
  const generate = root.querySelector<HTMLButtonElement>("#generate-digest");
  const schedule = root.querySelector<HTMLButtonElement>("#digest-schedule");
  const show = (text: string) => { notice.textContent = text; notice.hidden = !text; };
  async function send(button: HTMLButtonElement, method: "POST" | "PUT", body: unknown, busy: string) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = busy;
    show("");
    try {
      const response = await fetch("/api/apps/planning/digests", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`);
      if (!signal.aborted) location.reload();
    } catch (error) {
      if (signal.aborted) return;
      show(error instanceof Error ? error.message : "Request failed");
      button.disabled = false;
      button.textContent = label;
    }
  }
  const runs = root.querySelector<HTMLElement>(".planning-digest-runs");
  if (runs?.dataset.running === "true") {
    let finished = false;
    livePoll(signal, async () => {
      const response = await fetch("/api/apps/planning/digests", { signal });
      if (!response.ok) throw new Error(`Runs unavailable (${response.status})`);
      const latest = (await response.json()) as { status: string }[];
      finished = !latest.some((run) => run.status === "running");
      if (finished && !signal.aborted) location.reload();
    }, { every: 5000, until: () => finished });
  }
  generate?.addEventListener("click", () => send(generate, "POST", { projectId }, "Starting…"), { signal });
  schedule?.addEventListener("click", () => send(schedule, "PUT", { enabled: schedule.dataset.enabled !== "true" }, "Saving…"), { signal });
});
}
