// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: onPageLoad nests the whole page script, which counts every handler as nested.
import { onPageLoad } from "@ai-outfitter/ui/page";
import { append, el, statusPill } from "./dom";
import { appMount } from "./mount";
import { dailySchedule, type Schedule } from "./schedule";

type Source = { id: string; provider?: string; label: string; method: string; detail: string };
type ActivityEvent = { id: string; at: string; kind: string; title: string; detail: string; status?: string; runId?: string; stage?: string };

const PROVIDERS: Record<string, { letter: string; name: string; window: string }> = {
  gmail: { letter: "G", name: "Gmail", window: "Reads up to 40 messages in full, without quoted replies, skipping spam, trash and promotions." },
  "google-calendar": { letter: "C", name: "Google Calendar", window: "Reads up to 40 events on the primary calendar, through the next 14 days." },
  github: { letter: "H", name: "GitHub", window: "Reads up to 40 issues and pull requests you are involved in, each with its description and newest comments." },
  slack: { letter: "S", name: "Slack", window: "Reads up to 40 messages from the public channels you selected, each with its thread." },
};
/** How far back a rerun reads. The server keeps where an "everything" run stopped. */
const RANGES: [string, string][] = [
  ["since-last", "Since the last run"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["all", "Everything, continuing where the last one stopped"],
];
const STAGES: Record<string, string> = {
  preparing: "Getting ready…",
  reading: "Reading the source…",
  analyzing: "The agent is reading what came in…",
  validating: "Checking the agent’s answer…",
  saving: "Saving to your knowledge graph…",
};

const when = (value: string | number) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

onPageLoad((signal) => {
  const page = import.meta.env.OUTFITTER_APP_MODE === "operational" ? document.querySelector<HTMLElement>('[data-page="sources-list"]') : null;
  if (!page) return;
  const mount = appMount(1);
  const connected = document.getElementById("sources-connected") as HTMLElement;
  const runs = document.getElementById("sources-runs") as HTMLElement;
  const error = document.getElementById("sources-error") as HTMLElement;
  const fail = (e: unknown) => {
    if (signal.aborted) return;
    error.hidden = false;
    error.textContent = e instanceof Error ? e.message : "Could not load sources.";
  };
  async function call<T>(path: string, input?: unknown): Promise<T> {
    const response = await fetch(`${mount}/api/apps/forerunner/${path}`, input === undefined ? { signal } : {
      // Discovery writes a run and may still be analyzing when the member
      // leaves Sources. Keep that request alive across page navigation.
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), keepalive: true,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<T>;
  }

  /** One connected account: its status, the last run, and a Rerun that opens the confirmation panel. */
  function row(source: Source, schedule: Schedule | null) {
    const provider = source.id.startsWith("connection:") ? (source.provider ?? (source.label.startsWith("Gmail") ? "gmail" : "google-calendar")) : "sample";
    const meta = PROVIDERS[provider] ?? { letter: "S", name: "Saved sample", window: source.detail };
    const wrap = el("div", "source-row");
    wrap.dataset.source = source.id;
    const logo = el("span", `source-logo source-logo--${provider}`, meta.letter);
    logo.setAttribute("aria-hidden", "true");
    const text = el("div", "source-text");
    const heading = el("div", "source-heading");
    heading.appendChild(el("strong", undefined, source.label));
    const pill = el("span", "source-pill source-pill--ok", provider === "sample" ? "Saved sample" : "Connected");
    heading.appendChild(pill);
    const daily = schedule?.enabled && schedule.connectionId && source.id === `connection:${schedule.connectionId}`;
    const detail = el("span", "muted", daily
      ? `Daily run${schedule?.lastRunAt ? ` · last ran ${when(schedule.lastRunAt)}` : ""}${schedule?.lastOutcome ? ` · ${schedule.lastOutcome}` : ""}`
      : source.method === "Direct connection" ? "Not in the daily run. Rerun it any time." : source.detail);
    append(text, heading, detail);
    const rerun = el("button", "ui-button ui-button--secondary", "Rerun");
    rerun.type = "button";
    rerun.setAttribute("aria-expanded", "false");
    const panel = el("div", "source-panel");
    panel.hidden = true;
    panel.appendChild(el("strong", undefined, `Rerun ${source.label}`));
    panel.appendChild(el("p", "muted", `${meta.window} Findings at least 95% confident are added at once; the rest wait for your review.`));
    const range = el("select");
    for (const [value, label] of RANGES) range.appendChild(new Option(label, value));
    const rangeLabel = el("label", "source-range");
    append(rangeLabel, el("span", undefined, "Read"), range);
    if (provider !== "sample") panel.appendChild(rangeLabel);
    const actions = el("div", "manual-actions source-panel-actions");
    const cancel = el("button", "ui-button ui-button--secondary", "Cancel");
    cancel.type = "button";
    const run = el("button", "ui-button", "Run now");
    run.type = "button";
    append(actions, cancel, run);
    const progress = el("p", "muted");
    progress.setAttribute("role", "status");
    append(panel, actions, progress);
    const toggle = (open: boolean) => {
      panel.hidden = !open;
      rerun.setAttribute("aria-expanded", String(open));
    };
    rerun.addEventListener("click", () => toggle(panel.hidden === true));
    cancel.addEventListener("click", () => toggle(false));
    run.addEventListener("click", async () => {
      run.disabled = true;
      cancel.disabled = true;
      pill.textContent = "Running";
      pill.className = "source-pill source-pill--running";
      range.disabled = true;
      progress.textContent = STAGES.preparing;
      error.hidden = true;
      // While the run works, say which step it is on. The newest running run is this one.
      const clicked = Date.now() - 5000;
      const watch = window.setInterval(async () => {
        try {
          const { events } = await call<{ events: ActivityEvent[] }>("discovery/activity");
          const mine = events.find((e) => e.kind === "run" && e.stage && Date.parse(e.at) >= clicked);
          if (mine?.stage && STAGES[mine.stage]) progress.textContent = STAGES[mine.stage];
        } catch { /* the run itself reports failures */ }
      }, 2000);
      signal.addEventListener("abort", () => clearInterval(watch));
      try {
        const result = await call<{ id: string }>("discovery/discover", {
          sources: [source.id],
          ...(provider === "sample" ? {} : { range: range.value }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        clearInterval(watch);
        if (signal.aborted) return;
        location.assign(`${mount}/runs/${encodeURIComponent(result.id)}/inputs`);
      } catch (e) {
        clearInterval(watch);
        if (signal.aborted) return;
        range.disabled = false;
        fail(e);
        pill.textContent = "Run failed";
        pill.className = "source-pill source-pill--failed";
        progress.textContent = "The run did not complete. History has the details.";
        run.disabled = false;
        cancel.disabled = false;
      }
    });
    append(wrap, logo, text, rerun, panel);
    return wrap;
  }

  function runRow(event: ActivityEvent) {
    const a = el("a", "source-row source-run");
    a.href = `${mount}/runs/${encodeURIComponent(event.runId ?? event.id)}/inputs`;
    append(a, el("span", "muted source-run-when", when(event.at)), el("span", "source-run-what", `${event.title} · ${event.detail}`), statusPill(event.status));
    return a;
  }

  void (async () => {
    try {
      const [{ sources }, schedule, activity] = await Promise.all([
        call<{ sources: Source[] }>("discovery/sources"),
        // Turns the daily run on by default, the same as Settings.
        dailySchedule(mount, signal),
        call<{ events: ActivityEvent[] }>("discovery/activity").catch(() => ({ events: [] as ActivityEvent[] })),
      ]);
      const rows = sources.map((source) => row(source, schedule));
      if (!rows.length) {
        const none = el("div", "source-row source-row--soon");
        const text = el("div", "source-text");
        text.appendChild(el("strong", undefined, "No accounts connected"));
        const note = el("span", "muted");
        append(note, "Connect Google, GitHub or Slack in ", Object.assign(el("a", undefined, "Settings"), { href: `${mount}/settings` }), " to start discovery.");
        text.appendChild(note);
        none.appendChild(text);
        rows.push(none);
      }
      connected.replaceChildren(...rows);
      // GitHub and Slack are offered under "Not connected yet" until one is connected.
      for (const offer of document.querySelectorAll<HTMLElement>("[data-connect]"))
        offer.hidden = sources.some((source) => source.provider === offer.dataset.connect);
      const recent = activity.events.filter((event) => event.kind === "run").slice(0, 5);
      runs.replaceChildren(...(recent.length ? recent.map(runRow) : [el("p", "muted source-row", "No runs yet.")]));
    } catch (e) {
      fail(e);
      connected.replaceChildren();
      runs.replaceChildren();
    }
  })();
});
