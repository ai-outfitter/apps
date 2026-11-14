import { createKnowledgeGraphViewer, disposeKnowledgeGraphViewers } from "@ai-outfitter/ui/knowledge-graph";
import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { livePoll } from "@ai-outfitter/ui/live";
import { recordAddress } from "../lib/addresses";
import type { Graph } from "../lib/graph";
import {
  approvalText, type Batch, label, type BatchDetail, type BatchItem, type BatchOperation, batchItems, batchUrl, type Citation, citation,
  edgeTitle, findingList, findingsFor, getBatch, itemUrl, lineSummary, nameIndex, proposalAnchor, proposedGraph, proposedView,
  questionSection, resolveOperations, type Review, review,
} from "./batch-pages";
import { appUrl, call, demoMode, el, entityUrl, loadGraph } from "./data";

// Changes: the batches agents proposed, what each found, its evidence and
// confidence, and what happens if nobody reviews it. Reviewing is the member's
// own action; the page never approves on its own. The ontology steward's
// findings are advisory notes beside each proposal; they decide nothing. A batch
// page is the index; each proposal is read and decided on its record's page.

const stateLabels: Record<string, string> = {
  open: "Collecting", awaiting_review: "Waiting for review", committed: "Saved", rejected: "Rejected", discarded: "Discarded",
};
const fill = (target: Element, ...children: (Node | string | null | undefined | false)[]) =>
  target.replaceChildren(...children.filter((child): child is Node | string => !!child));
const time = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function summaryLine(summary: Batch["summary"]) {
  if (!summary) return "";
  const parts = Object.entries(summary.counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${n} ${name}`);
  if (summary.evidence) parts.push(`${summary.evidence} pieces of evidence`);
  return parts.join(", ");
}

/** What the person is told happens if they do nothing. */
export function deadlineText(batch: Pick<Batch, "state" | "reviewBy" | "policy">, now = Date.now()) {
  if (batch.state !== "awaiting_review") return null;
  if (batch.reviewBy && batch.reviewBy > now) return `Anything still waiting is approved automatically at ${clock(batch.reviewBy)} unless you review it.`;
  if (batch.reviewBy) return "The review window has ended; reload to see what was approved.";
  return "Nothing here is saved until you approve it.";
}

/** One line for a batch card: what the steward found. */
export function reviewLine(review: Review | null) {
  if (!review) return null;
  const errors = review.findings.filter((item) => item.severity === "error").length;
  const warnings = review.findings.filter((item) => item.severity === "warning").length;
  const parts = [errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : null, warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : null].filter(Boolean);
  return `Steward: ${parts.length ? parts.join(", ") : "no problems found"}${review.state === "failed" ? " (built-in checks only; the steward did not finish)" : ""}`;
}

/** The steward's latest review: its findings, coverage and the run that is its audit trail. */
function reviewSection(detail: BatchDetail, draw: (next: BatchDetail) => void) {
  const { review } = detail.batch;
  const again = detail.canReview && detail.batch.state !== "open" && detail.batch.state !== "discarded"
    ? el("button", { type: "button" }, review ? "Review again" : "Review now") : null;
  if (again) again.onclick = async () => {
    again.disabled = true;
    try { draw(await call<BatchDetail>("batches/steward-review", { batchId: detail.batch.id })); }
    catch (error) { again.disabled = false; again.parentElement?.appendChild(el("p", { role: "alert" }, String(error))); }
  };
  if (!review) return el("section", { class: "node-section" }, el("h2", {}, "Ontology review"), el("p", { class: "change-meta" }, "The ontology steward has not reviewed this batch."), again);
  const general = review.findings.filter((item) => item.ref === null);
  return el("section", { class: "node-section change-review" },
    el("h2", {}, "Ontology review"),
    el("p", {}, review.summary || reviewLine(review)),
    el("p", { class: "change-meta" }, [
      review.state === "failed" ? `The steward did not finish${review.error ? `: ${review.error}` : ""}. Built-in checks are shown.` : null,
      review.complete ? null : "Covered part of the batch.",
      `Reviewed ${time(review.finishedAt)}`,
      `prompt ${review.prompt.digest.slice(0, 12)}`,
    ].filter(Boolean).join(" · "),
      review.runId ? el("span", { title: "This review's batch-review workflow run, its audit trail" }, ` · run ${review.runId}`) : null),
    el("p", { class: "change-meta" }, "These findings are advice for whoever reviews the batch. They don't approve, reject or hold anything."),
    findingList(general),
    again,
  );
}

function bulkActions(detail: BatchDetail, draw: (next: BatchDetail) => void) {
  const waiting = detail.operations.filter((op) => op.state === "awaiting_review");
  if (!detail.canReview || !waiting.length) return null;
  return el("div", { class: "change-actions" },
    ...(["approve", "reject"] as const).map((verdict) => {
      const button = el("button", { type: "button", class: verdict === "approve" ? "primary" : "" }, verdict === "approve" ? `Approve all ${waiting.length}` : "Reject all");
      button.onclick = async () => {
        button.disabled = true;
        try { draw(await review(detail.batch.id, verdict)); }
        catch (error) { button.disabled = false; button.parentElement?.appendChild(el("p", { role: "alert" }, String(error))); }
      };
      return button;
    }));
}

/** What new records must connect to. Members ask an agent to change it. */
function anchorLine(graph: Graph, detail: BatchDetail) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const anchors = (detail.batch.anchors ?? []).flatMap(id => nodes.get(id) ?? []);
  return el("p", { class: "change-anchor change-meta" }, ...(anchors.length
    ? ["New records connect to ", ...anchors.flatMap((node, i) => [i ? ", " : "", el("a", { href: entityUrl(node.id, node.typeId) }, node.title)])]
    : ["New records need not connect to anything."]));
}

/** The batch's index: one line per proposal in walk order, each a link to its page; relationships sit under their node. */
function proposalIndex(detail: BatchDetail, view: Graph, items: BatchItem[]) {
  const names = nameIndex(view), types = new Map(view.types.map((type) => [type.id, type.title]));
  const flags = (op: BatchOperation) => {
    const found = findingsFor(detail, op.ref), errors = found.filter((item) => item.severity === "error").length, warnings = found.filter((item) => item.severity === "warning").length;
    const text = [errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : null, warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : null].filter(Boolean).join(", ");
    return el("span", { class: `change-line-flag${errors ? " change-line-error" : ""}` }, text);
  };
  const kind = (item: BatchItem) => {
    const typeId = item.op?.operation.attributes.typeId ?? view.nodes.find((node) => node.id === item.id)?.typeId;
    const name = item.kind === "type" ? "Type" : types.get(String(typeId)) ?? "Entry";
    return item.op?.operation.operation === "update" ? `Update · ${name}` : name;
  };
  const line = (item: BatchItem) => el("li", { class: `change-line${item.op ? ` change-${item.op.state}` : ""}`, ...(item.op ? { id: proposalAnchor(item.op) } : {}) },
    el("span", { class: "change-kind" }, item.op ? kind(item) : `Saved · ${kind(item)}`),
    el("a", { href: itemUrl(detail.batch.id, view, item) }, item.title),
    el("span", { class: "change-line-summary" }, item.op ? lineSummary(item.op) : ""),
    item.op ? flags(item.op) : el("span", {}),
    el("span", { class: "change-state" }, item.op ? approvalText(item.op) : ""),
    item.edges.length ? el("ul", { class: "change-line-edges" }, ...item.edges.map((edge) => el("li", { id: proposalAnchor(edge), class: `change-${edge.state}` },
      el("span", {}, edgeTitle(edge, names, types)), flags(edge), el("span", { class: "change-state" }, approvalText(edge))))) : null,
  );
  return items.length ? el("ul", { class: "change-lines" }, ...items.map(line)) : el("p", {}, "Nothing proposed yet.");
}

/** A question's proposal, linked to its page (an edge's is its node's page). */
function questionRef(items: BatchItem[], view: Graph, batchId: string, op: BatchOperation) {
  const item = items.find((candidate) => candidate.op?.ref === op.ref || candidate.edges.some((edge) => edge.ref === op.ref));
  const title = item?.op?.ref === op.ref ? item.title : label(op);
  return el("a", { href: item ? itemUrl(batchId, view, item) : `#${proposalAnchor(op)}` }, title);
}

/** The batch on its own as a graph; its nodes link to their pages. */
function batchGraph(root: HTMLElement, graph: Graph, operations: BatchOperation[], href: (id: string) => string | undefined) {
  const view = proposedView(graph, operations);
  const nodeTypes = new Map(view.nodes.map(node => [node.id, node.typeId]));
  const viewer = view.nodes.length
    ? createKnowledgeGraphViewer({ ...graph, types: view.types }, view, view.nodes[0], { initialScale: 0.85, nodeHref: (id) => href(id) ?? entityUrl(id, nodeTypes.get(id)), onError: (error) => root.appendChild(el("p", { role: "alert" }, `Unable to arrange graph: ${String(error)}`)) })
    : null;
  return { count: view.nodes.length, panel: el("div", { id: "batch-graph", class: "change-graph" }, viewer ?? el("p", {}, "No graph nodes in this batch.")) };
}

async function renderBatch(root: HTMLElement, batchId: string, signal: AbortSignal) {
  const [graph, detail] = await Promise.all([loadGraph(), getBatch(batchId)]);
  let currentSignature = "";
  let activeView = "proposals";
  const address = recordAddress(graph);
  const draw = (current: BatchDetail) => {
    if (signal.aborted) return;
    currentSignature = JSON.stringify(current);
    disposeKnowledgeGraphViewers(root);
    const { batch } = current;
    const operations = resolveOperations(graph, current.operations);
    agentPage("onto").describe({
      title: batch.title,
      summary: "Review the proposed Wiki changes, evidence, confidence and approval decisions. Each proposal opens on its own page.",
      state: { batchId: batch.id, state: batch.state, anchors: (batch.anchors ?? []).flatMap(id => address("graph-node", id) ?? []), validation: current.validation, counts: current.counts, proposalRefs: operations.slice(0, 100).map(op => op.ref), questions: (batch.questions ?? []).map(question => ({ key: question.key, answered: !!question.answer })) },
    });
    const view = proposedGraph(graph, operations).graph;
    const items = batchItems(view, operations);
    const urls = new Map(items.map((item) => [item.id, itemUrl(batch.id, view, item)]));
    const pictured = batchGraph(root, graph, operations, (id) => urls.get(id));
    const panels = {
      proposals: el("div", { id: "batch-proposals" }, proposalIndex(current, view, items)),
      graph: pictured.panel,
      review: el("div", { id: "batch-review" }, reviewSection(current, draw)),
    };
    const buttons = new Map<string, HTMLButtonElement>();
    const choose = (key: string) => {
      activeView = key;
      for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== key;
      for (const [name, button] of buttons) button.setAttribute("aria-pressed", String(name === key));
    };
    const tabs = el("nav", { class: "change-views", "aria-label": "Change batch views" }, ...[
      ["proposals", `Proposals (${operations.length})`], ["graph", `Graph (${pictured.count})`], ["review", "Review"],
    ].map(([key, label]) => {
      const button = el("button", { type: "button", "aria-controls": `batch-${key}`, onclick: () => choose(key) }, label);
      buttons.set(key, button); return button;
    }));
    choose(activeView);
    fill(root,
      el("p", {}, el("a", { href: appUrl("changes") }, "← All changes")),
      el("h2", {}, batch.title),
      el("p", { class: "change-meta" }, `${stateLabels[batch.state] ?? batch.state} · ${time(batch.createdAt)}`),
      el("details", { class: "change-description" }, el("summary", {}, "Batch summary"),
        el("p", { class: "change-summary" }, batch.summary?.text ?? summaryLine(batch.summary) ?? ""),
        batch.summary?.text && summaryLine(batch.summary) ? el("p", { class: "change-meta" }, summaryLine(batch.summary)) : null),
      deadlineText(batch) ? el("p", { class: "change-deadline", role: "status" }, deadlineText(batch)) : null,
      bulkActions(current, draw),
      questionSection(current, (op) => questionRef(items, view, batch.id, op), draw),
      current.validation ? el("p", { class: "change-validation", role: "status" }, current.validation.valid ? "Passing · Current proposals satisfy graph and anchor checks." : `Needs changes · ${current.validation.error}`) : null,
      anchorLine(graph, current),
      tabs, ...Object.values(panels),
    );
  };
  draw(detail);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  livePoll(signal, async () => {
    if (root.querySelector("form:focus-within")) return;
    const next = await getBatch(batchId);
    if (JSON.stringify(next) !== currentSignature) draw(next);
  }, { every: 5000 });
}

async function renderList(root: HTMLElement) {
  const { batches } = await call<{ batches: Batch[] }>("batches/list");
  agentPage("onto").describe({ title: "Wiki changes", summary: "Batches waiting for review and recent changes.", state: { batchIds: batches.slice(0, 50).map(batch => batch.id) } });
  const card = (batch: Batch) => el("li", { class: `change-batch change-${batch.state}` },
    el("a", { href: batchUrl(batch.id) }, batch.title),
    el("span", { class: "change-state" }, stateLabels[batch.state] ?? batch.state),
    el("p", {}, batch.summary?.text ?? summaryLine(batch.summary) ?? ""),
    el("p", { class: "change-meta" }, [
      batch.counts?.awaiting_review ? `${batch.counts.awaiting_review} waiting` : null,
      batch.counts?.committed ? `${batch.counts.committed} saved` : null,
      batch.counts?.rejected ? `${batch.counts.rejected} rejected` : null,
      `updated ${time(batch.updatedAt)}`,
    ].filter(Boolean).join(" · ")),
    deadlineText(batch) ? el("p", { class: "change-deadline" }, deadlineText(batch)) : null,
    reviewLine(batch.review) ? el("p", { class: "change-meta" }, reviewLine(batch.review)) : null,
  );
  const waiting = batches.filter((batch) => batch.state === "awaiting_review");
  const rest = batches.filter((batch) => batch.state !== "awaiting_review");
  fill(root,
    el("p", {}, "Agents propose Wiki changes in batches. Nothing in a batch is visible elsewhere in the Wiki until it is saved."),
    waiting.length ? el("section", { class: "node-section" }, el("h2", {}, "Waiting for review"), el("ul", { class: "change-batches" }, ...waiting.map(card))) : null,
    el("section", { class: "node-section" }, el("h2", {}, "Recent"), rest.length ? el("ul", { class: "change-batches" }, ...rest.map(card)) : el("p", {}, "No changes yet.")),
  );
}

/** Entity History: the batches that changed a record, who approved them and the evidence. */
export function historySection(id: string) {
  const section = el("details", { class: "node-section" }, el("summary", {}, "History"), el("p", { role: "status" }, "Loading history…"));
  if (demoMode) { section.replaceChildren(el("summary", {}, "History"), el("p", {}, "History is recorded in operational Wikis.")); return section; }
  section.addEventListener("toggle", async () => {
    if (!section.open || section.dataset.loaded) return;
    section.dataset.loaded = "true";
    try {
      const history = await call<{ revisions: { revision: number; batchId: string | null; batchTitle: string | null; approval: Record<string, unknown>; evidence: Citation[]; createdAt: number; created: boolean }[]; complete: boolean }>(`batches/history?id=${encodeURIComponent(id)}`);
      const approval = (value: Record<string, unknown>) =>
        value.kind === "policy" ? `approved by policy (${String(value.reason ?? value.policy)})` : value.kind === "member" ? "approved by a member" : "edited directly";
      fill(section,
        el("summary", {}, "History"),
        history.revisions.length
          ? el("ol", { class: "change-history" }, ...history.revisions.map((row) => el("li", {},
            el("strong", {}, `Revision ${row.revision}`), ` · ${row.created ? "created" : "changed"} ${time(row.createdAt)} · ${approval(row.approval)}`,
            row.batchId ? el("span", {}, " · ", el("a", { href: batchUrl(row.batchId) }, row.batchTitle ?? "batch")) : null,
            row.evidence.length ? el("ul", { class: "change-evidence" }, ...row.evidence.map(citation)) : null)))
          : el("p", {}, "No recorded changes."),
        history.complete ? null : el("p", { class: "change-meta" }, "Earlier revisions were made before change history was recorded."),
      );
    } catch (error) { section.appendChild(el("p", { role: "alert" }, String(error))); }
  });
  return section;
}

async function render(signal: AbortSignal) {
  const root = document.getElementById("changes");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "true";
  try {
    if (demoMode) root.replaceChildren(el("p", {}, "Change batches are available in operational Wikis."));
    else if (root.dataset.view === "batch" && root.dataset.batchId) await renderBatch(root, root.dataset.batchId, signal);
    else await renderList(root);
  } catch (error) {
    root.replaceChildren(el("p", { role: "alert" }, `Unable to load changes: ${String(error)}`));
  }
  root.setAttribute("aria-busy", "false");
}
onPageLoad(render);
