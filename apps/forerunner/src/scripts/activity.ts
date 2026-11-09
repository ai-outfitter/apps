// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: onPageLoad nests the whole page script, which counts every handler as nested.
import { livePoll } from "@ai-outfitter/ui/live";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { statusPill } from "./dom";
import { appMount } from "./mount";

function append(parent: Node, ...children: Node[]) {
  for (const child of children) parent.appendChild(child);
}
function required<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing activity element: ${selector}`);
  return element;
}
type ActivityEvent = {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string;
  status?: string;
  runId?: string;
};
onPageLoad((signal) => {
  const timeline = import.meta.env.OUTFITTER_APP_MODE === "operational" ? document.getElementById("activity-timeline") : null;
  if (!timeline) return;
  // History is one segment below the app root.
  const prefix = appMount(1);
  const endpoint = `${prefix}/api/apps/forerunner/discovery/activity`;
  const node = (tag: string, text: string) => {
    const el = document.createElement(tag);
    el.textContent = text;
    return el;
  };
  const read = async <T>(id?: string) => {
    const response = await fetch(
      id ? `${endpoint}?id=${encodeURIComponent(id)}` : endpoint,
      { signal },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<T>;
  };
  const fail = (error: unknown) => {
    if (signal.aborted) return;
    const el = required("#discovery-error");
    el.hidden = false;
    el.textContent =
      error instanceof Error ? error.message : "Could not load activity.";
  };
  function row(event: ActivityEvent) {
    const li = document.createElement("li");
    const item = document.createElement(event.runId ? "a" : "div");
    item.className = "activity-event";
    const content = document.createElement("span"),
      title = node("span", event.title);
    title.className = "activity-title";
    if (event.status) {
      const heading = document.createElement("span");
      heading.className = "activity-heading";
      append(heading, title, statusPill(event.status));
      append(content, heading, node("small", event.detail));
    } else append(content, title, node("small", event.detail));
    const time = document.createElement("time");
    time.dateTime = event.at;
    const date = new Date(event.at);
    time.textContent = date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    append(item, content, time);
    if (event.runId) item.setAttribute("href", `${prefix}/runs/${encodeURIComponent(event.runId)}/inputs`);
    li.appendChild(item);
    return li;
  }
  function groupedEvents(events: ActivityEvent[]) {
    const now = new Date(),
      today = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      ).getTime();
    const groups = new Map<string, ActivityEvent[]>();
    for (const event of events) {
      const date = new Date(event.at),
        day = new Date(
          date.getFullYear(),
          date.getMonth(),
          date.getDate(),
        ).getTime();
      const label =
        day >= today
          ? "Today"
          : day ===
              new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate() - 1,
              ).getTime()
            ? "Yesterday"
            : day >=
                new Date(
                  now.getFullYear(),
                  now.getMonth(),
                  now.getDate() - 6,
                ).getTime()
              ? "Last 7 days"
              : date.toLocaleDateString([], { month: "long", year: "numeric" });
      groups.set(label, [...(groups.get(label) ?? []), event]);
    }
    return groups;
  }
  async function refresh() {
    const { events, truncated } = await read<{
      events: ActivityEvent[];
      truncated: boolean;
    }>();
    timeline?.replaceChildren();
    if (!events.length) {
      const empty = document.createElement("section");
      empty.className = "paper";
      append(
        empty,
        node("h2", "Let Outfitter get to know you"),
        node(
          "p",
          "Connect your accounts so Outfitter can learn what matters to you and offer more relevant help over time.",
        ),
      );
      const link = node("a", "Choose your sources");
      link.setAttribute("href", `${prefix}/settings`);
      append(empty, link);
      timeline?.appendChild(empty);
    }
    const groups = groupedEvents(events);
    for (const [label, items] of groups) {
      const recent = label === "Today" || label === "Yesterday";
      const group = document.createElement(recent ? "section" : "details");
      group.className = "activity-group";
      append(
        group,
        node(
          recent ? "h2" : "summary",
          recent ? label : `${label} · ${items.length} events`,
        ),
      );
      const list = document.createElement("ol");
      append(list, ...items.map(row));
      append(group, list);
      timeline?.appendChild(group);
    }
    required("#activity-limit").textContent = truncated
      ? "Showing recent activity. Older records remain retained."
      : "";
  }
  refresh().catch(fail);
  const initial = new URL(location.href).searchParams.get("run");
  if (initial) location.replace(`${prefix}/runs/${encodeURIComponent(initial)}/inputs`);
  // New runs appear while the page is open; a pull-down refreshes at once.
  livePoll(signal, refresh, {
    every: 15000,
    skip: () => timeline.contains(document.activeElement),
    onError: fail,
  });
});
