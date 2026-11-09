import { append, el } from "./dom";
import { byRecord, modelAnswer, providerName, type Conclusion, type RunRecord } from "./run-model";
import { runPage, type RunPage } from "./run-page";
import { conclusionList, sender, short, when } from "./run-view";

let selected = "";
let filter: "all" | "used" | "unused" = "all";
let bound: HTMLElement | undefined;
runPage("inputs", (context: RunPage) => {
  const { root, records, list, byId } = context;
  if (bound !== root) {
    bound = root;
    selected = new URL(location.href).searchParams.get("item") ?? "";
    filter = "all";
  }
  function visible() {
    const cited = byRecord(list);
    const used = (r: RunRecord) => !!cited.get(r.ref)?.some((c) => c.outcome !== "dropped");
    return records.filter((r) => filter === "all" || (filter === "used" ? used(r) : !used(r)));
  }
  function renderItems() {
    const cited = byRecord(list);
    const shown = visible();
    if (!shown.some((r) => r.ref === selected)) selected = shown[0]?.ref ?? "";
    for (const chip of root?.querySelectorAll<HTMLButtonElement>(".run-filter [data-filter]") ?? [])
      chip.setAttribute("aria-pressed", String(chip.dataset.filter === filter));
    const listEl = byId("run-mail-list");
    listEl.replaceChildren(...shown.map((record) => {
      const li = el("li");
      const button = el("button", "run-mail-row");
      button.type = "button";
      button.setAttribute("aria-current", String(record.ref === selected));
      const found = (cited.get(record.ref) ?? []).filter((c) => c.outcome !== "dropped").length;
      const text = el("span", "run-mail-text");
      append(text, el("strong", undefined, record.subject || "Untitled"), el("span", "muted", [sender(record.from), short(record.date)].filter(Boolean).join(" · ")));
      const badge = el("span", found ? "run-mail-count" : "run-mail-count run-mail-count--none", found ? String(found) : "–");
      badge.setAttribute("aria-label", found ? `${found} ${found === 1 ? "change" : "changes"}` : "Nothing taken");
      const mark = el("span", `source-logo source-logo--${record.provider} run-mark`, providerName(record.provider).slice(0, 1));
      mark.title = providerName(record.provider);
      append(button, mark, text, badge);
      button.addEventListener("click", () => {
        selected = record.ref;
        renderItems();
        const url = new URL(location.href);
        url.searchParams.set("item", selected);
        history.replaceState(history.state, "", url);
        // On a phone the detail sits under the list; bring it into view.
        if (matchMedia("(max-width: 900px)").matches) byId("run-mail-detail").scrollIntoView({ block: "start", behavior: "smooth" });
      });
      li.appendChild(button);
      return li;
    }));
    if (!shown.length) listEl.appendChild(el("li", "muted run-empty", filter === "all" ? "This run kept no record of what it read." : "No items here."));
    renderItem(context, records.find((r) => r.ref === selected), cited);
  }
  root.onclick = (event) => {
    const chip = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".run-filter [data-filter]") : null;
    if (!chip) return;
    filter = chip.dataset.filter as typeof filter;
    renderItems();
  };
  renderItems();
});

  function renderItem(context: RunPage, record: RunRecord | undefined, cited: Map<string, Conclusion[]>) {
    const pane = context.byId("run-mail-detail");
    if (!record) {
      pane.replaceChildren(el("p", "muted", "Choose an item to see what the agent read and what it made of it."));
      return;
    }
    const head = el("header", "run-mail-head");
    const meta = el("p", "muted");
    append(meta, [sender(record.from), when(record.date)].filter(Boolean).join(" · "));
    meta.title = providerName(record.provider);
    if (record.url) {
      const open = el("a", "run-mail-open", `Open ↗`);
      open.href = record.url;
      open.target = "_blank";
      open.rel = "noopener";
      open.setAttribute("aria-label", `Open in ${providerName(record.provider)}`);
      append(meta, " · ", open);
    }
    append(head, el("h3", undefined, record.subject || "Untitled"), meta);
    const read = el("div", "run-mail-section");
    read.appendChild(el("blockquote", "run-excerpt", record.excerpt || "No text."));
    if (record.snippetOnly) read.appendChild(el("small", "muted", "Earlier run: preview snippet only."));
    const found = cited.get(record.ref) ?? [];
    const concluded = el("div", "run-mail-section");
    concluded.appendChild(el("h4", undefined, found.length ? `Concluded (${found.length})` : "Concluded"));
    if (!found.length) concluded.appendChild(el("p", "muted", modelAnswer(context.run) ? "Nothing." : "This run did not keep the agent’s answer."));
    else concluded.appendChild(conclusionList(context, found, record.ref));
    pane.replaceChildren(head, read, concluded);
  }
