// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: onPageLoad nests the whole page script, which counts every handler as nested.
import { onPageLoad } from "@ai-outfitter/ui/page";
import { append, el } from "./dom";
import { appMount } from "./mount";
import { type Block, type BoardItem, blocksFromBoard, type IconName } from "./today-blocks";

const ICONS = {
  video: "M23 7l-7 5 7 5V7zM1 5h15v14H1z",
  pick: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
  msg: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  gift: "M20 12v10H4V12M2 7h20v5H2zM12 22V7",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  graph: "M6 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6M18 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6M8.5 7.5l7 9",
  stone: "M12 2l9 5v10l-9 5-9-5V7z",
  suggestion: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z",
} satisfies Record<IconName, string>;

const SVG = "http://www.w3.org/2000/svg";
function icon(path: string, size = 14) {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", path);
  svg.appendChild(p);
  return svg;
}

/** Draws the timeline. Links are relative to the app root, so they stay inside the app wherever it is mounted. */
export function renderTimeline(container: HTMLElement, blocks: Block[], root: string) {
  const rows = blocks.map((block) => {
    const row = el("div", `today-row today-row--${block.kind}${block.done ? " today-row--done" : ""}`);
    row.dataset.block = block.id;
    const rail = el("div", "today-rail");
    rail.appendChild(el("span", "today-dot"));
    const body = el("div", "today-body");
    if (block.kind === "now") {
      const card = el("div", "today-now");
      card.appendChild(el("div", "today-now-title", block.title));
      if (block.action) {
        const a = el("a", "ui-button", block.action.label);
        a.href = root + block.action.href;
        card.appendChild(a);
      }
      body.appendChild(card);
    } else if (block.kind === "batch") {
      const card = el("div", "today-batch");
      const heading = el("div", "today-batch-heading");
      heading.appendChild(el("strong", undefined, block.title));
      if (block.length) heading.appendChild(el("span", "muted", block.length));
      card.appendChild(heading);
      for (const item of block.items ?? []) {
        const a = el("a", "today-item");
        a.href = root + item.href;
        a.dataset.item = item.id;
        const badge = el("span", "today-item-icon");
        badge.appendChild(icon(ICONS[item.icon] ?? ICONS.pick));
        append(a, badge, el("span", "today-item-title", item.title), el("span", "today-item-action muted", `${item.action} ›`));
        card.appendChild(a);
      }
      body.appendChild(card);
    } else {
      body.appendChild(el("div", "today-event-title", block.title));
    }
    if (block.time) body.appendChild(el("div", "today-time muted", block.time));
    if (block.proof) body.appendChild(el("div", "today-proof", block.proof));
    append(row, rail, body);
    return row;
  });
  container.replaceChildren(...rows);
}

onPageLoad((signal) => {
  const container = document.getElementById("today-timeline");
  if (!container) return;
  const root = container.dataset.root ?? "./";
  const demo = document.getElementById("today-data");
  if (demo) {
    renderTimeline(container, (JSON.parse(demo.textContent || "{}") as { blocks: Block[] }).blocks, root);
    return;
  }
  // The demo bundle must ship no operational browser calls, so the build drops the rest.
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") return;
  const mount = appMount(0);
  // The date and greeting follow the member's clock, like the due dates below.
  const now = new Date();
  const date = document.getElementById("today-date"), greeting = document.getElementById("today-greeting");
  if (date) date.textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(now);
  if (greeting) greeting.textContent = now.getHours() < 12 ? "Morning." : now.getHours() < 18 ? "Afternoon." : "Evening.";
  const empty = document.getElementById("today-empty");
  const error = document.getElementById("today-error");
  const read = async <T>(path: string) => {
    const response = await fetch(`${mount}/api/apps/forerunner/${path}`, { signal });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as T;
  };
  void (async () => {
    try {
      const [{ items }, { entities }, { suggestions }] = await Promise.all([
        read<{ items: BoardItem[] }>("items"),
        read<{ entities: { status: string }[] }>("discovery/entities").catch(() => ({ entities: [] })),
        read<{ suggestions: unknown[] }>("workflows").catch(() => ({ suggestions: [] })),
      ]);
      const waiting = entities.filter((entity) => entity.status === "pending").length;
      const today = now.toLocaleDateString("en-CA");
      const blocks = blocksFromBoard(items, waiting, today, suggestions.length);
      renderTimeline(container, blocks, root);
      if (empty) empty.hidden = blocks.length > 0;
    } catch (e) {
      if (signal.aborted || !error) return;
      error.hidden = false;
      error.textContent = e instanceof Error ? e.message : "Could not load today.";
      container.replaceChildren();
    }
  })();
});
