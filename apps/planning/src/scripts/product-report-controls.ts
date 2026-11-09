import { onPageLoad } from "@ai-outfitter/ui/page";
import { livePoll } from "@ai-outfitter/ui/live";
if (import.meta.env.OUTFITTER_APP_MODE !== "demo")
  onPageLoad((signal) => {
    const root = document.getElementById("product-report-actions");
    const status = document.getElementById("product-report-run-status");
    if (!root || !status) return;
    const mount = location.pathname.replace(/\/products\/?$/, "");
    const endpoint = `${mount}/api/apps/planning/product-report`;
    const generate = document.getElementById(
      "regenerate-product-report",
    ) as HTMLButtonElement | null;
    const daily = document.getElementById(
      "daily-product-report",
    ) as HTMLInputElement | null;
    let running = false;
    async function request(method = "GET", data?: Record<string, unknown>) {
      const response = await fetch(endpoint, {
        method,
        signal,
        headers: { "Content-Type": "application/json" },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    function showLatest(runs: { id: string; status: string }[]) {
      const last = runs[0];
      if (!last) {
        status!.hidden = true;
        return;
      }
      status!.hidden = last.status === "complete";
      status!.textContent =
        last.status === "running"
          ? "Updating roadmap…"
          : `Roadmap update: ${last.status}`;
      if (running && last.status === "complete") location.reload();
      running = last.status === "running";
      if (generate) generate.disabled = running;
    }
    async function refresh() {
      try {
        const data = (await request()) as {
          productReportSchedule: { enabled: boolean };
          productReportRuns: { id: string; status: string }[];
        };
        if (signal.aborted) return;
        if (daily) daily.checked = data.productReportSchedule.enabled;
        showLatest(data.productReportRuns);
      } catch (error) {
        if (!signal.aborted) {
          status!.hidden = false;
          status!.textContent =
            error instanceof Error
              ? error.message
              : "Cannot read roadmap workflow status.";
        }
      }
    }
    generate?.addEventListener(
      "click",
      async () => {
        generate.disabled = true;
        try {
          await request("POST", {});
          running = true;
          status.hidden = false;
          status.textContent = "Updating roadmap…";
          await refresh();
        } catch (error) {
          if (!signal.aborted) {
            generate.disabled = false;
            status.hidden = false;
            status.textContent =
              error instanceof Error ? error.message : "Cannot start report.";
          }
        }
      },
      { signal },
    );
    daily?.addEventListener(
      "change",
      async () => {
        daily.disabled = true;
        try {
          await request("PUT", { enabled: daily.checked });
        } catch (error) {
          if (!signal.aborted) {
            daily.checked = !daily.checked;
            status.hidden = false;
            status.textContent =
              error instanceof Error
                ? error.message
                : "Cannot change schedule.";
          }
        } finally {
          if (!signal.aborted) daily.disabled = false;
        }
      },
      { signal },
    );
    void refresh();
    livePoll(signal, refresh, { every: 5000 });
  });
