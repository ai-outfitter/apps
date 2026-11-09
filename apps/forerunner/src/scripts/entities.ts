// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: onPageLoad nests the whole page script, which counts every handler as nested.
import { onPageLoad } from "@ai-outfitter/ui/page";
import { append, el } from "./dom";
import { type Entity, filterEntities, type Status } from "./entities-filter";
import { appMount } from "./mount";
import { wikiBase } from "./wiki";

const added = (iso: string) => {
  const date = new Date(iso), today = new Date();
  const days = Math.round((today.setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86400000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : date.toLocaleDateString([], { month: "short", day: "numeric" });
};

onPageLoad((signal) => {
  const page = import.meta.env.OUTFITTER_APP_MODE === "operational" ? document.querySelector<HTMLElement>('[data-page="entities"]') : null;
  if (!page) return;
  const mount = appMount(1);
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const summary = byId("entities-summary"), error = byId("entities-error"), search = byId<HTMLInputElement>("entities-search");
  const statusGroup = byId("entities-status"), types = byId("entities-types"), rows = byId("entities-rows"), empty = byId("entities-empty"), shown = byId("entities-shown");
  const requested = new URLSearchParams(location.search).get("status");
  let status: Status = requested === "pending" || requested === "accepted" ? requested : "all";
  let kind: string | null = null;
  let entities: Entity[] = [];

  function chip(label: string, count: number, on: boolean, pick: () => void, className: string) {
    const button = el("button", className);
    button.type = "button";
    button.setAttribute("aria-pressed", String(on));
    append(button, label, " ", el("span", "muted", String(count)));
    button.addEventListener("click", () => {
      pick();
      draw();
    });
    return button;
  }
  function draw() {
    const counts = { all: entities.length, pending: entities.filter((e) => e.status === "pending").length, accepted: entities.filter((e) => e.status === "accepted").length };
    statusGroup.replaceChildren(...(["all", "pending", "accepted"] as const).map((key) =>
      chip(key === "all" ? "All" : key === "pending" ? "Pending" : "Accepted", counts[key], status === key, () => { status = key; }, "entities-switch-option")));
    const byKind = new Map<string, number>();
    for (const entity of entities) byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1);
    types.replaceChildren(chip("All", entities.length, kind === null, () => { kind = null; }, "entities-chip"),
      ...[...byKind].sort((a, b) => b[1] - a[1]).map(([name, count]) => chip(name, count, kind === name, () => { kind = name; }, "entities-chip")));
    const visible = filterEntities(entities, search.value, status, kind);
    rows.replaceChildren(...visible.map((entity) => {
      const tr = el("tr");
      tr.dataset.entity = entity.id;
      const name = el("td");
      const link = el("a", "entities-name", entity.title);
      // A pending addition is not a Wiki record yet; its batch's review page shows it.
      link.href = entity.status === "pending" && entity.batchId
        ? `${wikiBase(entity.wikiSlug)}/changes/${encodeURIComponent(entity.batchId)}`
        : `${wikiBase(entity.wikiSlug)}/entities/${encodeURIComponent(entity.id)}`;
      name.appendChild(link);
      const statusCell = el("td");
      statusCell.appendChild(el("span", `source-pill source-pill--${entity.status}`, entity.status === "pending" ? "Pending" : "Accepted"));
      append(tr, name, el("td", "muted", entity.kind), el("td", "muted", entity.foundIn.join(", ") || "—"), el("td", "entities-num", String(entity.links)), el("td", "muted entities-when", added(entity.addedAt)), statusCell);
      return tr;
    }));
    empty.hidden = visible.length > 0;
    shown.textContent = `Showing ${visible.length} of ${entities.length}.${counts.pending ? " Pending items are approved at the end of your day unless you review them." : ""}`;
  }
  search.addEventListener("input", draw);
  void (async () => {
    try {
      const response = await fetch(`${mount}/api/apps/forerunner/discovery/entities`, { signal });
      if (!response.ok) throw new Error(await response.text());
      entities = ((await response.json()) as { entities: Entity[] }).entities;
      summary.textContent = entities.length
        ? `${entities.length} ${entities.length === 1 ? "thing" : "things"} Forerunner knows about your life.`
        : "Nothing has been added yet. Rerun a source to start.";
      draw();
    } catch (e) {
      if (signal.aborted) return;
      summary.textContent = "";
      error.hidden = false;
      error.textContent = e instanceof Error ? e.message : "Could not load the knowledge graph.";
    }
  })();
});
