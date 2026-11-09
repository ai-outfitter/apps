import { append, el } from "./dom";
import { type Conclusion, type Outcome, outcomeLabel, providerName } from "./run-model";
import type { RunPage } from "./run-page";
export const when = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};
export const percent = (value?: number) => (value === undefined ? "" : `${Math.round(value * 100)}%`);
export const outcomeTone: Record<Outcome, string> = {
  added: "accepted", waiting: "pending", matched: "neutral", known: "neutral", corrected: "neutral", unsaved: "neutral", dropped: "dropped",
};
export const pill = (o: Outcome) => el("span", `source-pill run-pill source-pill--${outcomeTone[o]} run-pill--${outcomeTone[o]}`, outcomeLabel[o]);
/** "Priya Shah <priya@example.test>" reads as "Priya Shah" in the list. */
export const sender = (from: string) => from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"(.*)"$/, "$1") || from;
export const short = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
export const json = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? "Not recorded", null, 2));

  export function itemChip(context: RunPage, ref: string) {
    const record = context.records.find((r) => r.ref === ref);
    const chip = el("a", "run-chip", record ? record.subject || "Untitled" : ref);
    chip.title = record ? `${providerName(record.provider)} · ${when(record.date)}` : "";
    chip.href = `${context.base}/inputs?item=${encodeURIComponent(ref)}`;
    return chip;
  }

  export function conclusionList(context: RunPage, found: Conclusion[], current?: string) {
    const ul = el("ul", "run-conclusions");
    append(ul, ...found.map(c => conclusion(context, c, current)));
    return ul;
  }
export function confidence(value: number) {
    const wrap = el("span", "run-confidence");
    wrap.title = value >= 0.95 ? "At least 95%: added without review" : "Below 95%: waits for review";
    const bar = el("span", "run-confidence-bar");
    const fill = el("span");
    fill.style.width = `${Math.round(value * 100)}%`;
    bar.appendChild(fill);
    append(wrap, bar, percent(value));
    return wrap;
  }

function conclusion(context: RunPage, c: Conclusion, current?: string) {
      const li = el("li", `run-conclusion run-conclusion--${c.outcome}`);
      const top = el("div", "run-conclusion-top");
      const title = el("span", "run-conclusion-title");
      const name = el(c.entryIndex === undefined ? "strong" : "a", c.entryIndex === undefined ? undefined : "run-name", c.name);
      if (name instanceof HTMLAnchorElement) {
        name.title = "Show this change";
        name.href = `${context.base}/changes#run-change-${c.entryIndex}`;
      }
      append(title, el("span", "run-type", c.kind === "relationship" ? "Relationship" : c.type), name);
      append(top, title, pill(c.outcome));
      li.appendChild(top);
      if (c.note) li.appendChild(el("p", undefined, c.note));
      const meta = el("div", "run-conclusion-meta");
      if (c.confidence !== undefined) meta.appendChild(confidence(c.confidence));
      const others = c.evidence.filter((ref) => ref !== current);
      if (others.length) {
        const also = el("span", "run-also");
        for (const ref of others) also.appendChild(itemChip(context, ref));
        meta.appendChild(also);
      }
      if (meta.childElementCount) li.appendChild(meta);
      return li;
}
