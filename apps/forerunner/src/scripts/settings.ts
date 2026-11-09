// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: onPageLoad nests the whole page script, which counts every handler as nested.
import { onPageLoad } from "@ai-outfitter/ui/page";
import { append, el } from "./dom";
import { appMount } from "./mount";
import { dailySchedule, type Schedule } from "./schedule";

type Source = { id: string; provider?: string; label: string; method: string; detail: string; lastRunAt?: number | null };

const when = (value: string | number) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const provider = (source: Source) => source.provider ?? (source.label.startsWith("Gmail") ? "gmail" : "google-calendar");
const LETTERS: Record<string, string> = { gmail: "G", "google-calendar": "C", github: "H", slack: "S" };

// Settings: the daily run, the accounts it can read and what is left to connect.
// Present only in the operational package; the demo renders static rows.
onPageLoad((signal) => {
  const page = import.meta.env.OUTFITTER_APP_MODE === "operational" ? document.querySelector<HTMLElement>('[data-page="settings"]') : null;
  if (!page) return;
  const mount = appMount(1);
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`settings-${id}`) as T;
  const error = byId("error");
  const toggle = byId<HTMLInputElement>("daily");
  const pill = byId("daily-pill");
  const status = byId("daily-status");
  // A select read only for its value; the root check resolves HTMLSelectElement to a non-DOM type.
  const choice = byId<HTMLElement & { value: string }>("daily-source");
  const fail = (e: unknown) => {
    if (signal.aborted) return;
    error.hidden = !e;
    error.textContent = e instanceof Error ? e.message : "";
  };
  let accounts: Source[] = [];
  let destination = "personal";

  /** Redraws the daily row from the server's answer. */
  function daily(schedule: Schedule | null) {
    if (!schedule) {
      toggle.disabled = true;
      pill.textContent = "Unavailable";
      pill.className = "source-pill source-pill--failed";
      status.textContent = "The daily run is unavailable right now.";
      return;
    }
    const reads = accounts.find((source) => source.id === `connection:${schedule.connectionId}`);
    if (reads) choice.value = reads.id;
    toggle.disabled = !accounts.length;
    toggle.checked = schedule.enabled;
    pill.textContent = schedule.enabled ? "On" : "Off";
    pill.className = `source-pill${schedule.enabled ? " source-pill--ok" : ""}`;
    const where = destination === "organization" ? "this organization's knowledge graph" : "your knowledge graph";
    if (!accounts.length) status.textContent = "Connect Google below and the daily run starts on its own.";
    else if (!schedule.enabled) status.textContent = "Off. Turn it on to read one account every morning.";
    else
      status.textContent = [
        `Reads ${reads?.label ?? "your account"} into ${where}.`,
        `Next run ${schedule.nextRunAt ? when(schedule.nextRunAt) : "soon"}.`,
        schedule.lastOutcome ? `Last run${schedule.lastRunAt ? ` ${when(schedule.lastRunAt)}` : ""}: ${schedule.lastOutcome}.` : "",
      ].filter(Boolean).join(" ");
  }

  async function save(enabled: boolean) {
    fail(null);
    toggle.disabled = true;
    try {
      const response = await fetch(`${mount}/api/apps/forerunner/schedule`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal,
        body: JSON.stringify({ enabled, source: choice.value || undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (!response.ok) throw new Error(await response.text());
      daily(((await response.json()) as { schedule: Schedule }).schedule);
    } catch (e) {
      fail(e);
      daily(await dailySchedule(mount, signal));
    }
  }
  toggle.addEventListener("change", () => void save(toggle.checked), { signal });
  choice.addEventListener("change", () => { if (toggle.checked) void save(true); }, { signal });

  /** One connected account in the Sources page's row style, with its last run. */
  function row(source: Source) {
    const kind = provider(source);
    const wrap = el("div", "source-row");
    wrap.dataset.source = source.id;
    const logo = el("span", `source-logo source-logo--${kind}`, LETTERS[kind] ?? "S");
    logo.setAttribute("aria-hidden", "true");
    const heading = append(el("div", "source-heading"), el("strong", undefined, source.label), el("span", "source-pill source-pill--ok", "Connected"));
    const text = append(el("div", "source-text"), heading, el("span", "muted", source.lastRunAt ? `Last ran ${when(source.lastRunAt)}` : "Not run yet"));
    return append(wrap, logo, text);
  }

  function sources(list: Source[]) {
    const rows = list.map(row);
    if (!rows.length) rows.push(append(el("div", "source-row"), append(el("div", "source-text"), el("strong", undefined, "No accounts connected yet"), el("span", "muted", "Connect Google, GitHub or Slack below so Forerunner has something to read."))));
    else rows.push(append(el("p", "source-row muted"), append(el("span"), "Rerun one source, or see recent runs, on ", Object.assign(el("a", undefined, "Sources"), { href: `${mount}/sources` }), ".")));
    byId("sources").replaceChildren(...rows);
    // More than one account: choose which one the daily run reads.
    choice.replaceChildren(...list.map((source) => new Option(source.label, source.id)));
    byId("daily-account").hidden = list.length < 2;
    // Google is offered while Gmail or Calendar is still missing.
    const missing = (["gmail", "google-calendar"] as const).filter((kind) => !list.some((source) => provider(source) === kind));
    byId("google").hidden = !missing.length;
    byId("google-detail").textContent = missing.length === 2
      ? "Gmail and Google Calendar, for the daily run."
      : `${missing[0] === "gmail" ? "Gmail" : "Google Calendar"} is not connected yet.`;
    // GitHub and Slack are offered until connected.
    for (const offer of document.querySelectorAll<HTMLElement>("[data-connect]"))
      offer.hidden = list.some((source) => provider(source) === offer.dataset.connect);
    // A personal install returns through /connect; other mounts manage Google in the platform.
    if (/^\/apps\/[a-f0-9-]+$/.test(mount)) byId<HTMLAnchorElement>("google-connect").href = `/connect?returnTo=${encodeURIComponent(`${mount}/settings`)}`;
  }

  void (async () => {
    try {
      const response = await fetch(`${mount}/api/apps/forerunner/discovery/sources`, { signal });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as { sources: Source[]; destination: string };
      accounts = result.sources.filter((source) => source.id.startsWith("connection:"));
      destination = result.destination;
      sources(accounts);
      const schedule = await dailySchedule(mount, signal);
      if (!signal.aborted) daily(schedule);
    } catch (e) {
      fail(e);
      byId("sources").replaceChildren();
      daily(null);
    }
  })();
});
