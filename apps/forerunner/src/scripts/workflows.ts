import { livePoll } from "@ai-outfitter/ui/live";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { append, el } from "./dom";
import { appMount } from "./mount";

type Target = { scope: string; app: string };
// What the platform documents say runs for the member (see src/server/workflows.ts).
type Workflow = {
  key: string; kind: "app" | "routine"; target: Target; workflow: string; routine: string | null; name: string; cadence: string; enabled: boolean;
  nextRunAt: number | null; lastRun: { status: string; href: string | null } | null; lastOutcome: string | null; canChange: boolean; canDelete: boolean;
};
type Run = { target: Target; run: string; name: string; status: string; stage: string | null; startedAt: number; updatedAt: number; href: string | null };
type Task = { title: string; description: string; cadence: string | null; steps: string[] };
type Suggestion = {
  id: string; kind: "workflow" | "change" | "app"; title: string; why: string; routineId: string | null; routineName: string | null;
  task: Task | null; appName: string | null; appGoal: string | null; createdAt: string;
};
type View = { workflows: Workflow[]; workflowRuns: Run[]; suggestions: Suggestion[] };

// The demo shows what the page looks like with no account behind it.
const sample: View = {
  workflows: [
    { key: "personal/forerunner/forerunner-discovery", kind: "app", target: { scope: "personal", app: "forerunner" }, workflow: "forerunner-discovery", routine: null, name: "Daily discovery",
      cadence: "Every day at 07:00 America/Chicago", enabled: true, nextRunAt: Date.now() + 36e6, lastRun: { status: "complete", href: "runs/sample" }, lastOutcome: "started", canChange: true, canDelete: false },
    { key: "routine:brief", kind: "routine", target: { scope: "personal", app: "platform" }, workflow: "recurring-task", routine: "brief", name: "Morning brief",
      cadence: "Weekdays at 13:00 UTC", enabled: true, nextRunAt: Date.now() + 6e7, lastRun: { status: "complete", href: null }, lastOutcome: "started", canChange: true, canDelete: true },
    { key: "routine:invoices", kind: "routine", target: { scope: "personal", app: "platform" }, workflow: "recurring-task", routine: "invoices", name: "Invoice follow-ups",
      cadence: "Every Monday at 09:00 America/Chicago", enabled: false, nextRunAt: null, lastRun: null, lastOutcome: null, canChange: true, canDelete: true },
  ],
  workflowRuns: [{ target: { scope: "personal", app: "forerunner" }, run: "00000000-0000-4000-8000-000000000001", name: "Discovery", status: "running", stage: "analyzing",
    startedAt: Date.now() - 6e4, updatedAt: Date.now(), href: "runs/sample" }],
  suggestions: [
    { id: "i1", kind: "change", title: "Brief on markets and the yoga studio", why: "Most mornings bring studio sign-up questions as well as market news.", routineId: "brief", routineName: "Morning brief",
      task: { title: "Morning brief", description: "Summarize market news and new yoga studio sign-ups, with a reply to draft for each question.", cadence: "Weekdays at 8am", steps: ["Read the news", "Read new sign-ups", "Draft replies"] },
      appName: null, appGoal: null, createdAt: new Date().toISOString() },
    { id: "i2", kind: "workflow", title: "Plan Thanksgiving guests", why: "Several invitations and replies about Thanksgiving arrived this week.", routineId: null, routineName: null,
      task: { title: "Thanksgiving guests", description: "List who confirmed, what each brings, and draft a reminder for anyone who has not replied.", cadence: "Every Monday", steps: [] },
      appName: null, appGoal: null, createdAt: new Date().toISOString() },
    { id: "i3", kind: "app", title: "Class sign-ups", why: "Students ask about classes by email several times a week.", routineId: null, routineName: null, task: null,
      appName: "Class sign-ups", appGoal: "Keep sign-ups and their answers in one place.", createdAt: new Date().toISOString() },
  ],
};

const when = (at: number) => new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const results: Record<string, [string, string]> = { running: ["Running", "running"], complete: ["Done", "ok"], failed: ["Failed", "failed"] };
const pill = (status: string) => {
  const [text, tone] = results[status] ?? [status, "pending"];
  return el("span", `source-pill source-pill--${tone}`, text);
};
const stageText = (stage: string | null) => (stage ? `${stage[0].toUpperCase()}${stage.slice(1)}…` : "Running…");

onPageLoad((signal) => {
  const list = document.getElementById("workflows-list");
  if (!list) return;
  const demo = import.meta.env.OUTFITTER_APP_MODE !== "operational";
  // Workflows is one segment below the app root.
  const prefix = appMount(1);
  const endpoint = `${prefix}/api/apps/forerunner/workflows`;
  const notice = document.getElementById("workflows-error") as HTMLElement;
  const show = (error: unknown) => {
    if (signal.aborted) return;
    notice.hidden = false;
    notice.textContent = error instanceof Error ? error.message : "Something went wrong. Try again.";
  };
  // A discovery run opens in Forerunner (a path under the app); a routine's on the main site.
  const runHref = (href: string) => (href.startsWith("/") ? href : `${prefix}/${href}`);

  async function change(body: Record<string, unknown>, button?: HTMLButtonElement) {
    if (demo) return;
    if (button) button.disabled = true;
    notice.hidden = true;
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
      if (!response.ok) throw new Error((await response.text()) || "That did not work. Try again.");
      await refresh();
    } catch (error) {
      show(error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function action(label: string, body: Record<string, unknown>) {
    const button = el("button", "ui-button ui-button--secondary", label);
    button.type = "button";
    button.addEventListener("click", () => change(body, button), { signal });
    return button;
  }

  function menu(workflow: Workflow) {
    const details = el("details", "workflows-menu");
    const summary = el("summary", "workflows-menu-toggle", "⋯");
    summary.setAttribute("aria-label", `Actions for ${workflow.name}`);
    const items = el("div", "workflows-menu-items");
    const item = (label: string, body: Record<string, unknown>, confirmText?: string) => {
      const button = el("button", "workflows-menu-item", label);
      button.type = "button";
      button.addEventListener("click", () => {
        details.open = false;
        // Delete asks once, in place: the first press arms it.
        if (confirmText && button.dataset.armed !== "true") {
          button.dataset.armed = "true";
          button.textContent = confirmText;
          details.open = true;
          return;
        }
        void change(body);
      }, { signal });
      return button;
    };
    // Each change is one platform ScheduleChanges item: a routine by its id, an app's schedule by its workflow.
    const which = { target: workflow.target, ...(workflow.routine ? { routine: workflow.routine } : { workflow: workflow.workflow }) };
    const schedule = (change: string) => ({ action: "schedule", item: { change, ...which } });
    append(items, item("Run now", schedule("run")));
    append(items, item(workflow.enabled ? "Pause" : "Resume", schedule(workflow.enabled ? "pause" : "resume")));
    if (workflow.canDelete) append(items, item("Delete", schedule("delete"), "Press again to delete"));
    append(details, summary, items);
    return details;
  }

  function row(workflow: Workflow) {
    const tr = document.createElement("tr");
    const name = el("td");
    append(name, el("strong", "workflows-name", workflow.name));
    const result = el("td");
    if (workflow.lastRun?.href) {
      const link = el("a");
      link.href = runHref(workflow.lastRun.href);
      append(link, pill(workflow.lastRun.status));
      append(result, link);
    } else if (workflow.lastRun) append(result, pill(workflow.lastRun.status));
    else append(result, el("span", "muted", workflow.lastOutcome ? workflow.lastOutcome : "Not run yet"));
    const next = el("td", workflow.enabled ? "entities-when" : "entities-when workflows-paused", workflow.enabled ? (workflow.nextRunAt ? when(workflow.nextRunAt) : "—") : "Paused");
    const actions = el("td", "workflows-actions");
    if (workflow.canChange) append(actions, menu(workflow));
    name.dataset.label = "Workflow";
    result.dataset.label = "Last result";
    next.dataset.label = "Next run";
    const runs = el("td", "workflows-cadence", workflow.cadence);
    runs.dataset.label = "Runs";
    append(tr, name, runs, result, next, actions);
    return tr;
  }

  function running(run: Run) {
    const item = el("div", "source-row");
    const text = el("div", "source-text");
    const name = run.href ? el("a", "workflows-name", run.name) : el("strong", "workflows-name", run.name);
    if (run.href) (name as HTMLAnchorElement).href = runHref(run.href);
    append(text, name, el("span", "muted", `${stageText(run.stage)} Started ${when(run.startedAt)}`));
    const buttons = el("div", "workflows-run-actions");
    append(buttons, action("Cancel", { action: "cancel", item: { target: run.target, run: run.run } }));
    append(item, text, buttons);
    return item;
  }

  function suggestionKind(item: Suggestion) {
    if (item.kind === "change") return `Change to ${item.routineName ?? "a routine"}`;
    return item.kind === "app" ? "New app" : "New workflow";
  }

  /** A workflow or change's task: when it runs, what it does and its steps. */
  function suggestionTask(task: NonNullable<Suggestion["task"]>) {
    const more = el("details", "workflows-suggestion-task");
    append(more, el("summary", undefined, task.cadence ? `${task.cadence} · how it works` : "How it works"), el("p", undefined, task.description));
    if (task.steps.length) {
      const steps = el("ol");
      append(steps, ...task.steps.map((step) => el("li", undefined, step)));
      append(more, steps);
    }
    return more;
  }

  function suggestionActions(item: Suggestion) {
    const buttons = el("div", "workflows-run-actions");
    if (item.kind === "app") {
      // Apps are built from the main site's Apps page.
      const build = el("a", "ui-button ui-button--secondary", "Build in Apps");
      build.href = "/apps";
      append(buttons, build);
    } else {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const apply = action(item.kind === "change" ? "Apply change" : "Turn on", { action: "suggestion", id: item.id, status: "applied", timezone });
      apply.classList.remove("ui-button--secondary");
      append(buttons, apply);
    }
    append(buttons, action("Not now", { action: "suggestion", id: item.id, status: "dismissed" }));
    return buttons;
  }

  function suggestion(item: Suggestion) {
    const card = el("div", "source-row workflows-suggestion");
    const text = el("div", "source-text");
    append(text, el("span", "workflows-suggestion-kind muted", suggestionKind(item)), el("strong", "workflows-name", item.title), el("span", "muted", item.why));
    if (item.task) append(text, suggestionTask(item.task));
    else if (item.appGoal) append(text, el("span", "muted", item.appGoal));
    append(card, text, suggestionActions(item));
    return card;
  }

  function render(view: View) {
    // A routine with a suggested change says so on its row.
    const changes = new Map<string, number>();
    for (const item of view.suggestions) if (item.kind === "change" && item.routineId) changes.set(item.routineId, (changes.get(item.routineId) ?? 0) + 1);
    list?.replaceChildren(...view.workflows.map((workflow) => {
      const tr = row(workflow);
      const count = workflow.routine ? changes.get(workflow.routine) : undefined;
      if (count) {
        const hint = el("a", "workflows-hint", `${count} suggested ${count === 1 ? "change" : "changes"}`);
        hint.href = "#suggestions";
        append(tr.cells[0] as HTMLElement, el("br"), hint);
      }
      return tr;
    }));
    const suggestions = document.getElementById("suggestions") as HTMLElement;
    suggestions.hidden = !view.suggestions.length;
    document.getElementById("workflows-suggestions")?.replaceChildren(...view.suggestions.map(suggestion));
    const now = view.workflowRuns.filter((run) => run.status === "running");
    const section = document.getElementById("workflows-running-section") as HTMLElement;
    section.hidden = !now.length;
    document.getElementById("workflows-running")?.replaceChildren(...now.map(running));
  }

  async function refresh() {
    if (demo) return render(sample);
    const response = await fetch(endpoint, { signal });
    if (!response.ok) throw new Error((await response.text()) || "Could not load your workflows.");
    render(await response.json());
  }

  refresh().then(() => {
    // Today's "Look at suggestions" lands here.
    if (location.hash === "#suggestions") document.getElementById("suggestions")?.scrollIntoView();
  }).catch(show);
  // Runs start and finish while the page is open; an open menu holds still.
  livePoll(signal, refresh, { every: 5000, skip: () => Boolean(document.querySelector(".workflows-menu[open], .workflows-suggestion-task[open]")), onError: show });
});
