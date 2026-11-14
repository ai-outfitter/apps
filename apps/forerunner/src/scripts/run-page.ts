import { livePoll } from "@ai-outfitter/ui/live";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { el } from "./dom";
import type { Preview } from "./preview";
import { type Conclusion, conclusions, duration, providerName, type Run, type RunRecord, runRecords, stageLabel, stepTimes } from "./run-model";
import { when } from "./run-view";
import { wikiBase } from "./wiki";

type Detail = { run: Run; preview: Preview | null };
export type RunPage = Detail & {
  root: HTMLElement; signal: AbortSignal; demo: boolean; base: string;
  records: RunRecord[]; list: Conclusion[];
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T;
  call: <T>(path: string, input?: unknown) => Promise<T>;
  load: () => Promise<void>;
};

/** One request-scoped lifecycle for the shared header and the current page only. */
export function runPage(view: "inputs" | "changes" | "transcript", render: (context: RunPage) => void) {
  onPageLoad((signal) => {
    const element = document.querySelector<HTMLElement>('[data-page="run"]');
    if (!element || element.dataset.runView !== view) return;
    const root = element;
    const demo = import.meta.env.OUTFITTER_APP_MODE !== "operational";
    const runId = root.dataset.runId ?? "";
    const base = location.pathname.replace(/\/(inputs|changes|transcript)\/?$/, "");
    const prefix = base.replace(/\/runs\/[^/]+$/, "");
    const endpoint = `${prefix}/api/apps/forerunner/discovery`;
    const byId = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`) as T;
    async function call<T>(path: string, input?: unknown): Promise<T> {
      if (demo) throw new Error("The demo is read-only.");
      const response = await fetch(`${endpoint}/${path}`, input === undefined ? { signal } : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), keepalive: true,
      });
      signal.throwIfAborted();
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    let context: RunPage;
    async function load() {
      const detail = import.meta.env.OUTFITTER_APP_MODE === "operational"
        ? await call<Detail>(`activity?id=${encodeURIComponent(runId)}`)
        : ((await import("../../fixtures/forerunner-run.json")).default as unknown as Detail);
      if (signal.aborted) return;
      context = { ...detail, root, signal, demo, base, byId, call, load, records: runRecords(detail.run, detail.preview), list: conclusions(detail.run, detail.preview) };
      renderHeader(context);
      byId("run-tab-inputs").textContent = `Inputs (${context.records.length})`;
      byId("run-tab-changes").textContent = `Changes (${context.list.filter(c => c.outcome !== "dropped").length})`;
      byId("run-feedback").hidden = demo || !detail.preview?.receipt;
      const last = detail.preview?.evaluations?.filter(e => e.rating !== "corrected").at(-1);
      byId("evaluation-status").textContent = last ? "Feedback saved. Thank you." : "";
      render(context);
    }

  byId<HTMLFormElement>("evaluation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const preview = context?.preview;
    if (!preview) return;
    const form = new FormData(event.currentTarget as HTMLFormElement),
      button = (event.currentTarget as HTMLFormElement).querySelector("button") as HTMLButtonElement;
    button.disabled = true;
    try {
      await call("evaluate", { previewId: preview.id, requestId: crypto.randomUUID(), rating: form.get("rating"), note: form.get("note") });
      await load();
    } catch (e) {
      if (signal.aborted) return;
      byId("evaluation-status").textContent = e instanceof Error ? e.message : "Could not save feedback.";
    } finally {
      button.disabled = false;
    }
  });
  byId<HTMLButtonElement>("export-evaluation").addEventListener("click", async (event) => {
    const button=event.currentTarget as HTMLButtonElement;
    button.disabled=true;
    try {
      // Demo builds ship no operational browser calls (tests/demo-package-assets.test.ts).
      if (demo) throw new Error("The demo has no run session to download.");
      const response=await fetch(`${endpoint}/session?id=${encodeURIComponent(runId)}`);
      if(!response.ok)throw new Error(await response.text() || "Could not download this run.");
      const url=URL.createObjectURL(await response.blob());
      const a=document.createElement("a");
      a.href=url;a.download=`workflow-session-${runId}.json`;
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(error){
      const message=byId("activity-run-error");message.hidden=false;
      message.textContent=error instanceof Error?error.message:"Could not download this run.";
    } finally {button.disabled=false;}
  });

    const loadFailed = (error: unknown) => {
      if (signal.aborted) return;
      byId("activity-run-status").textContent = "Could not load this run.";
      byId("activity-run-error").hidden = false;
      byId("activity-run-error").textContent = error instanceof Error ? error.message : "Try again.";
    };
    void load().catch(loadFailed);
    livePoll(signal, load, { every: 4000, until: () => Boolean(context) && ["complete", "failed"].includes(context.run.status), onError: loadFailed });
  });
}
  function renderHeader(context: RunPage) {
    const { run, preview } = context;
    const parts = statusParts(run, preview);
    const status = context.byId("activity-run-status");
    status.replaceChildren(el("strong", `run-state run-state--${preview?.receipt ? "saved" : run.status}`, parts[0]), ` · ${parts.slice(1).join(" · ")}`);
    // A failed run always says why, and at which step, even when older runs saved no reason.
    renderFailure(context);
    renderReview(context);
  }

function renderReview(context: RunPage) {
    const { preview, demo } = context;
    const review = context.byId<HTMLAnchorElement>("run-review");
    const waiting = preview?.receipt?.counts?.awaiting_review ?? 0;
    review.hidden = demo || !preview?.batch;
    if (preview?.batch) {
      review.textContent = waiting ? `Review ${waiting} ${waiting === 1 ? "change" : "changes"}` : "View batch";
      review.className = waiting ? "ui-button" : "ui-button ui-button--secondary";
      const by = preview.receipt?.reviewBy;
      review.title = waiting && by ? `Approved automatically at ${new Date(by).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "";
      review.href = `${wikiBase(preview.wikiSlug)}/changes/${encodeURIComponent(preview.batch.batchId)}`;
    }
}

function renderFailure(context: RunPage) {
  const { run } = context;
    const failure = run.status === "failed"
      ? `${run.failedWhile ? `Failed while ${stageLabel[run.failedWhile]?.toLowerCase() ?? run.failedWhile}: ` : "Failed: "}${run.error ?? "no reason was recorded. Run discovery again."}`
      : run.error;
    context.byId("activity-run-error").hidden = !failure;
    context.byId("activity-run-error").textContent = failure ?? "";
}

function statusParts(run: Run, preview: Preview | null) {
    const running = !["complete", "failed"].includes(run.status);
    const state = preview?.receipt ? "Saved" : run.status === "complete" ? "Not saved" : running ? `Running · ${stageLabel[run.status] ?? run.status}` : "Failed";
    const steps = stepTimes(run.stages);
    const took = steps.length > 1 ? Date.parse(steps.at(-1)?.at ?? "") - Date.parse(steps[0].at) : NaN;
    return [
      state,
      when(run.startedAt),
      run.trigger === "schedule" ? "Daily" : "",
      Number.isFinite(took) && !running ? duration(took) : "",
      [...new Set(preview?.sources.map((s) => providerName(s.label.split(" · ")[0])) ?? [])].join(", "),
    ].filter(Boolean);
}
