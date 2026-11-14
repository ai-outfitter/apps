import { DISCOVERY_PREVIEW_VERSION } from "../discovery-version";
import { append, el } from "./dom";
import type { Preview } from "./preview";
import type { Conclusion } from "./run-model";
import { runPage } from "./run-page";
import { itemChip, percent, pill } from "./run-view";
import { wikiBase } from "./wiki";

runPage("changes", (context) => {
  const { root, signal, demo, run, preview, list, byId, call, load } = context;
  function correction(entry: Preview["entries"][number], index: number, preview: Preview) {
    const panel = el("details", "match-correction"),
      body = el("div"),
      search = el("input"),
      select = el("select"),
      button = el("button", "ui-button ui-button--secondary", "Use this match"),
      status = el("p");
    append(panel, el("summary", undefined, "Correct match"), body);
    search.placeholder = "Find the right person or entity";
    search.setAttribute("aria-label", `Find a match for ${entry.title}`);
    select.setAttribute("aria-label", `Correct match for ${entry.title}`);
    button.type = "button";
    button.disabled = true;
    append(body, search, select, button, status);
    let currentId = "",
      request = 0;
    async function find() {
      const seq = ++request;
      button.disabled = true;
      try {
        const result = await call<{ currentId: string; candidates: { id: string; title: string }[] }>(
          `matches?previewId=${encodeURIComponent(preview.id)}&entryIndex=${index}&query=${encodeURIComponent(search.value)}`,
        );
        if (signal.aborted || seq !== request) return;
        currentId = result.currentId;
        select.replaceChildren(...result.candidates.map((c) => new Option(c.title, c.id)));
        select.value = currentId;
        button.disabled = !select.value;
        status.textContent = "Updates this run’s match and its saved relationships.";
      } catch (e) {
        if (signal.aborted) return;
        status.textContent = e instanceof Error ? e.message : "Could not load matches.";
      }
    }
    panel.addEventListener("toggle", () => {
      if (panel.open) void find();
    });
    let timer: ReturnType<typeof setTimeout>;
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void find(), 200);
    });
    select.addEventListener("change", () => {
      button.disabled = !select.value;
    });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await call("correct-match", { previewId: preview.id, requestId: crypto.randomUUID(), entryIndex: index, expectedId: currentId, targetId: select.value });
        await load();
      } catch (e) {
        if (signal.aborted) return;
        status.textContent = e instanceof Error ? e.message : "Could not correct match.";
        button.disabled = false;
      }
    });
    return panel;
  }
  function changeRow(c: Conclusion, preview: Preview | null) {
    const entry = c.entryIndex === undefined ? undefined : preview?.entries[c.entryIndex];
    const row = el("article", "result-row run-change");
    if (c.entryIndex !== undefined) row.id = `run-change-${c.entryIndex}`;
    const heading = el("div", "result-heading");
    const title = el("div", "run-change-title");
    append(title, el("h4", undefined, c.name));
    if (c.note) title.appendChild(el("p", "muted", c.note));
    const actions = el("div", "result-row-actions");
    if (c.confidence !== undefined) actions.appendChild(el("span", "run-change-confidence", percent(c.confidence)));
    actions.appendChild(pill(c.outcome));
    append(heading, title, actions);
    row.appendChild(heading);
    if (c.evidence.length) {
      const from = el("div", "run-change-from");
      append(from, ...c.evidence.map(ref => itemChip(context, ref)));
      row.appendChild(from);
    }
    if (!entry || !preview || c.entryIndex === undefined) return row;
    addOptions(row, actions, entry, c.entryIndex, preview);
    return row;
  }
  function addOptions(row: HTMLElement, actions: HTMLElement, entry: Preview["entries"][number], index: number, preview: Preview) {
    const menu = el("details", "result-menu"),
      trigger = el("summary", undefined, "⋯"),
      choices = el("div", "result-menu-choices");
    trigger.setAttribute("aria-label", `More options for ${entry.matchedTitle ?? entry.title}`);
    trigger.setAttribute("role", "button");
    append(menu, trigger, choices);
    actions.appendChild(menu);
    const evidence = el("details", "result-expanded");
    append(evidence, el("summary", undefined, "What will be written"), el("pre", undefined, entry.excerpt));
    evidence.hidden = true;
    row.appendChild(evidence);
    function option(label: string, panel: HTMLDetailsElement) {
      const button = el("button", undefined, label);
      button.type = "button";
      button.addEventListener("click", () => {
        menu.open = false;
        panel.hidden = false;
        panel.open = true;
      });
      panel.addEventListener("toggle", () => {
        if (!panel.open) panel.hidden = true;
      });
      choices.appendChild(button);
    }
    option("What will be written", evidence);
    if (!demo && preview.receipt && entry.kind !== "Proposed relationship") {
      const panel = correction(entry, index, preview);
      panel.classList.add("result-expanded");
      panel.hidden = true;
      row.appendChild(panel);
      option("Correct match", panel);
    }
    const id = entry.matchedId ?? entry.id;
    if (!demo && id && entry.kind !== "Proposed relationship") {
      choices.appendChild(entryLink(preview, id));
    }
    menu.addEventListener("toggle", () => {
      if (menu.open)
        root?.querySelectorAll<HTMLDetailsElement>(".result-menu[open]").forEach((other) => {
          if (other !== menu) other.open = false;
        });
    });
  }
  function renderChanges(preview: Preview | null) {
    const groups = new Map<string, Conclusion[]>();
    for (const c of list) {
      const key = c.outcome === "dropped" ? "Dropped by checks" : c.kind === "relationship" ? "Relationships" : c.type;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    // Dropped proposals go last; they never reach the graph.
    const ordered = [...groups].sort(([a], [b]) => Number(a === "Dropped by checks") - Number(b === "Dropped by checks"));
    const nodes = ordered.map(([kind, items], groupIndex) => {
      const group = el("div", "result-group");
      group.setAttribute("role", "group");
      const heading = el("h3", undefined, kind);
      heading.id = `result-group-${groupIndex}`;
      group.setAttribute("aria-labelledby", heading.id);
      const header = el("div", "result-group-heading");
      append(header, heading, el("span", undefined, String(items.length)));
      group.appendChild(header);
      if (kind === "Dropped by checks") {
        const notes = Array.isArray(run.warnings) ? run.warnings : preview?.warnings ?? [];
        header.title = notes.length ? notes.join(" ") : "Proposed by the agent, removed by Forerunner’s checks. Never written.";
      }
      append(group, ...items.map((c) => changeRow(c, preview)));
      return group;
    });
    if (!nodes.length) nodes.push(el("p", "muted", run.status === "failed" ? "This run failed before it proposed any changes." : "This run proposed no changes."));
    byId("discovery-entries").replaceChildren(...nodes);
  }
    const wiki = byId<HTMLAnchorElement>("discovery-wiki");
    wiki.hidden = demo || !preview?.receipt;
    if (preview) wiki.href = `${wikiBase(preview.wikiSlug)}/`;
    byId("save-earlier").hidden = demo || !preview || !!preview.receipt || preview.version !== DISCOVERY_PREVIEW_VERSION;

  byId("save-earlier").onclick = async () => {
    if (!preview) return;
    try {
      await call("save", { previewId: preview.id, confirmDestination: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await load();
    } catch (e) {
      if (signal.aborted) return;
      byId("activity-run-error").hidden = false;
      byId("activity-run-error").textContent = e instanceof Error ? e.message : "Could not save.";
    }
  };
  renderChanges(preview);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" });
});

/** A saved record in the Wiki; a pending addition is not a record yet, so its batch's review page. */
function entryLink(preview: Preview, id: string) {
  const batchId = preview.receipt?.waiting?.includes(id) ? preview.batch?.batchId : undefined;
  const link = el("a", undefined, batchId ? "Review in Wiki" : "View entry");
  link.href = batchId
    ? `${wikiBase(preview.wikiSlug)}/changes/${encodeURIComponent(batchId)}`
    : `${wikiBase(preview.wikiSlug)}/entities/${encodeURIComponent(id)}`;
  return link;
}
