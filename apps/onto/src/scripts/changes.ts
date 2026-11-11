import { createKnowledgeGraphViewer, disposeKnowledgeGraphViewers } from "@ai-outfitter/ui/knowledge-graph";
import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { livePoll } from "@ai-outfitter/ui/live";
import { addressIndex, nodeAddress, recordAddress } from "../lib/addresses";
import { micromark } from "micromark";
import type { Graph, GraphEdge, GraphNode } from "../lib/graph";
import { appUrl, call, demoMode, el, entityUrl, loadGraph } from "./data";

// Changes: the batches agents proposed, what each found, its evidence and
// confidence, and what happens if nobody reviews it. Reviewing is the member's
// own action; the page never approves on its own. The ontology steward's
// findings are advisory notes beside each proposal; they decide nothing.

type Citation = { provider: string; recordId: string; uri?: string; quote?: string; observedAt?: string; version?: string };
type Operation = { operation: "create" | "update"; type: "graph-type" | "graph-node" | "graph-edge"; ref: string; id?: string; attributes: Record<string, unknown> };
type BatchOperation = {
  ref: string; operation: Operation; evidence: Citation[]; confidence: number | null; reason: string | null;
  state: string; decision: Record<string, unknown> | null; recordId: string | null;
};
type Batch = {
  id: string; title: string; purpose: string; state: string; reviewBy: number | null; createdAt: number; updatedAt: number;
  policy: { kind: string; threshold?: number }; source: { kind: string; ref: string; label?: string } | null;
  summary: { counts: Record<string, number>; evidence: number; operations: number; text: string | null } | null;
  counts?: Record<string, number>;
  anchors?: string[] | null;
  review: Review | null;
};
type Finding = { ref: string | null; rule: string; severity: "error" | "warning" | "note"; message: string; fix: string | null };
type Review = {
  state: "complete" | "failed"; runId: string | null; prompt: { path: string; digest: string };
  startedAt: number; finishedAt: number; complete: boolean; summary: string; findings: Finding[]; error: string | null;
};
type BatchDetail = { batch: Batch; counts: Record<string, number>; operations: BatchOperation[]; canReview: boolean; validation?: { valid: boolean; error: string | null; operations: number } };

const stateLabels: Record<string, string> = {
  open: "Collecting", awaiting_review: "Waiting for review", committed: "Saved", rejected: "Rejected", discarded: "Discarded",
};
const opLabels: Record<string, string> = {
  pending: "Collecting", awaiting_review: "Waiting", committed: "Saved", rejected: "Rejected",
};
const fill = (target: Element, ...children: (Node | string | null | undefined | false)[]) =>
  target.replaceChildren(...children.filter((child): child is Node | string => !!child));
const time = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const batchUrl = (id: string) => appUrl(`changes/${encodeURIComponent(id)}`);

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

function title(op: BatchOperation, names: Map<string, string>, types: Map<string, string>) {
  const a = op.operation.attributes;
  if (op.operation.type === "graph-edge") {
    const end = (value: unknown) => names.get(String(value)) ?? "an existing entity";
    return `${end(a.fromId)} → ${types.get(String(a.typeId)) ?? "related to"} → ${end(a.toId)}`;
  }
  return String(a.title ?? a.name ?? op.ref);
}

function citation(item: Citation) {
  const source = `${item.provider} · ${item.recordId}${item.version ? ` (version ${item.version})` : ""}`;
  return el("li", {},
    item.uri ? el("a", { href: item.uri, rel: "noreferrer noopener", target: "_blank" }, source) : el("span", {}, source),
    item.observedAt ? el("span", { class: "change-meta" }, ` · ${time(Date.parse(item.observedAt))}`) : null,
    item.quote ? el("blockquote", {}, item.quote) : null,
  );
}

/** The proposed records as graph nodes and edges, over the current Wiki for existing endpoints. */
function proposedView(graph: Graph, ops: BatchOperation[]) {
  const live = ops.filter((op) => op.state !== "rejected");
  const refs = new Map(ops.map((op) => [op.ref, recordIdOf(op)]));
  const nodes = new Map<string, GraphNode>();
  for (const op of live.filter((item) => item.operation.type === "graph-node")) {
    const id = recordIdOf(op), a = op.operation.attributes;
    const saved = graph.nodes.find((node) => node.id === id);
    nodes.set(id, { ...(saved ?? {}), id, typeId: String(a.typeId ?? saved?.typeId ?? ""), title: String(a.title ?? saved?.title ?? op.ref) } as GraphNode);
  }
  const resolve = (value: unknown) => refs.get(String(value)) ?? String(value);
  const edges: GraphEdge[] = [];
  for (const op of live.filter((item) => item.operation.type === "graph-edge")) {
    const a = op.operation.attributes;
    const fromId = resolve(a.fromId), toId = resolve(a.toId);
    for (const end of [fromId, toId]) addSaved(graph, nodes, end);
    if (nodes.has(fromId) && nodes.has(toId))
      edges.push({ id: recordIdOf(op), typeId: String(a.typeId), fromId, toId, title: "", body: "", properties: {}, archived: false } as GraphEdge);
  }
  return { nodes: [...nodes.values()], edges };
}
function recordIdOf(op: BatchOperation) {
  const id = op.operation.attributes.id;
  return op.recordId ?? (typeof id === "string" ? id : op.operation.id) ?? op.ref;
}
function addSaved(graph: Graph, nodes: Map<string, GraphNode>, id: string) {
  const saved = graph.nodes.find((node) => node.id === id);
  if (saved && !nodes.has(id)) nodes.set(id, saved);
}

async function review(batchId: string, verdict: "approve" | "reject", refs?: string[]) {
  return call<BatchDetail>("batches/review", { batchId, verdict, ...(refs ? { refs } : {}) });
}

function verdictButton(detail: BatchDetail, op: BatchOperation, verdict: "approve" | "reject", rerender: (next: BatchDetail) => void) {
  const button = el("button", { type: "button", class: verdict === "approve" ? "primary" : "" }, verdict === "approve" ? "Approve" : "Reject");
  button.onclick = async () => {
    button.disabled = true;
    try { rerender(await review(detail.batch.id, verdict, [op.ref])); }
    catch (error) { button.disabled = false; button.parentElement?.appendChild(el("p", { role: "alert" }, String(error))); }
  };
  return button;
}

const policyReasons: Record<string, string> = {
  "first-run": "Created on the first run",
  "review-window": "Approved when the review window ended",
  confidence: "Approved automatically: high confidence",
};
/** How a committed operation was approved, or its state. */
function approvalText(op: BatchOperation) {
  if (op.state !== "committed") return opLabels[op.state] ?? op.state;
  const decision = op.decision as { kind?: string; reason?: string } | null;
  if (decision?.kind !== "policy") return "Approved by a member";
  return policyReasons[decision.reason ?? ""] ?? policyReasons.confidence;
}

const severityLabels: Record<Finding["severity"], string> = { error: "Error", warning: "Warning", note: "Note" };
function findingList(findings: Finding[]) {
  if (!findings.length) return null;
  return el("ul", { class: "change-findings" }, ...findings.map((item) => el("li", { class: `change-finding change-finding-${item.severity}` },
    el("strong", {}, `${severityLabels[item.severity]} · ${item.rule}: `), item.message,
    item.fix ? el("p", { class: "change-meta" }, `Suggested fix: ${item.fix}`) : null)));
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

const proposalAnchor = (op: BatchOperation) => `proposal-${encodeURIComponent(op.ref).replaceAll("%", "_")}`;

function documentPreview(op: BatchOperation) {
  const body = op.operation.attributes.body;
  if (typeof body !== "string" || !body.trim()) return null;
  const prose = el("div", { class: "prose" });
  prose.innerHTML = micromark(body, { allowDangerousHtml: false, allowDangerousProtocol: false });
  return el("details", { open: true }, el("summary", {}, "Document preview"), prose);
}

function operationRow(detail: BatchDetail, op: BatchOperation, names: Map<string, string>, types: Map<string, string>, rerender: (next: BatchDetail) => void) {
  const kind = op.operation.type === "graph-edge" ? "Relationship" : types.get(String(op.operation.attributes.typeId)) ?? "Entry";
  const actions = detail.canReview && op.state === "awaiting_review"
    ? el("div", { class: "change-actions" }, verdictButton(detail, op, "approve", rerender), verdictButton(detail, op, "reject", rerender))
    : null;
  const how = approvalText(op);
  return el("li", { id: proposalAnchor(op), class: `change-operation change-${op.state}` },
    el("div", { class: "change-heading" },
      el("div", { class: "change-heading-main" },
        el("span", { class: "change-kind" }, `${op.operation.operation === "update" ? "Update · " : ""}${kind}`),
        op.recordId && op.state === "committed" ? el("a", { href: entityUrl(op.recordId, typeof op.operation.attributes.typeId === "string" ? op.operation.attributes.typeId : undefined) }, title(op, names, types)) : el("a", { href: `#${proposalAnchor(op)}` }, title(op, names, types)),
        op.confidence === null ? null : el("span", { class: "change-meta", title: "The producing agent's own confidence" }, `${Math.round(op.confidence * 100)}% confident`),
      ),
      actions,
    ),
    op.reason ? el("p", {}, op.reason) : null,
    findingList(detail.batch.review?.findings.filter((item) => item.ref === op.ref) ?? []),
    documentPreview(op),
    op.evidence.length
      ? el("details", {}, el("summary", {}, `Evidence (${op.evidence.length})`), el("ul", { class: "change-evidence" }, ...op.evidence.map(citation)))
      : el("p", { class: "change-meta" }, "No evidence cited."),
    el("span", { class: "change-state" }, how),
  );
}

/** Titles for records and refs, so relationships read as names. */
function nameIndex(graph: Graph, operations: BatchOperation[]) {
  const names = new Map<string, string>(graph.nodes.map((node) => [node.id, node.title]));
  for (const op of operations.filter((item) => item.operation.type === "graph-node")) {
    const a = op.operation.attributes;
    for (const key of [op.ref, op.recordId, a.id]) if (typeof key === "string") names.set(key, String(a.title ?? op.ref));
  }
  return names;
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

function anchorSection(graph: Graph, detail: BatchDetail, draw: (next: BatchDetail) => void) {
  const selected = new Set(detail.batch.anchors ?? []);
  const nodes = graph.nodes.filter(node => !node.archived && node.slug).sort((a, b) => a.title.localeCompare(b.title));
  const editable = detail.canReview && (detail.batch.state === "open" || detail.batch.state === "awaiting_review" && detail.batch.policy.kind === "member" && !detail.counts.committed && !detail.counts.rejected);
  const choices = el("div", { class: "change-anchor-options" }, ...nodes.map(node => {
    const address = nodeAddress(graph.types.find(type => type.id === node.typeId)?.name ?? node.typeId, node.slug!);
    const check = el("input", { type: "checkbox", value: address, checked: selected.has(node.id), disabled: !editable });
    return el("label", {}, check, node.title, el("span", { class: "change-meta" }, address));
  }));
  const form = el("form", { class: "change-anchors" },
    el("p", {}, "New nodes must connect to an anchor through saved or proposed relationships. No anchors means no connectivity requirement."),
    choices, editable ? el("button", { type: "submit" }, "Save anchors") : el("p", { class: "change-meta" }, "Anchors are fixed after review decisions."));
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector("button")!;
    button.disabled = true;
    try {
      draw(await call<BatchDetail>("batches/configure", { batchId: detail.batch.id, anchors: [...choices.querySelectorAll<HTMLInputElement>("input:checked")].map(input => input.value) }));
    } catch (error) { button.disabled = false; form.appendChild(el("p", { role: "alert" }, String(error))); }
  };
  return el("details", { class: "node-section" }, el("summary", {}, `Anchor nodes (${selected.size})`), form);
}

async function renderBatch(root: HTMLElement, batchId: string, signal: AbortSignal) {
  const [graph, detail] = await Promise.all([loadGraph(), call<BatchDetail>(`batches/get?id=${encodeURIComponent(batchId)}`)]);
  let currentSignature = "";
  let activeView = location.hash.startsWith("#proposal-") ? "proposals" : "graph";
  const index = addressIndex(graph), address = recordAddress(graph);
  const draw = (current: BatchDetail) => {
    if (signal.aborted) return;
    currentSignature = JSON.stringify(current);
    disposeKnowledgeGraphViewers(root);
    const { batch } = current;
    const operations = current.operations.map(op => {
      const operation = structuredClone(op.operation), a = operation.attributes;
      if (operation.id) operation.id = index[operation.type].get(operation.id) ?? operation.id;
      for (const field of ["typeId", "fromId", "toId"] as const) {
        if (typeof a[field] === "string") a[field] = index[field === "typeId" ? "graph-type" : "graph-node"].get(a[field]) ?? a[field];
      }
      return { ...op, operation };
    });
    // Types proposed in this batch name its records too, before anything is saved.
    const proposedTypes = operations.filter(op => op.operation.type === "graph-type" && op.state !== "rejected");
    const typeRefs = new Map(proposedTypes.map(op => [op.ref, recordIdOf(op)]));
    for (const { operation } of operations) {
      const typeId = operation.attributes.typeId;
      if (typeof typeId === "string" && typeRefs.has(typeId)) operation.attributes.typeId = typeRefs.get(typeId);
    }
    const shown: Graph = { ...graph, types: [...graph.types, ...proposedTypes
      .filter(op => !graph.types.some(type => type.id === recordIdOf(op)))
      .map(op => ({ body: "", properties: [], archived: false, ...op.operation.attributes, id: recordIdOf(op), title: String(op.operation.attributes.title ?? op.operation.attributes.name ?? op.ref) }) as unknown as Graph["types"][number])] };
    agentPage("onto").describe({
      title: batch.title,
      summary: "Review the proposed Wiki changes, evidence, confidence and approval decisions.",
      state: { batchId: batch.id, state: batch.state, anchors: (batch.anchors ?? []).flatMap(id => address("graph-node", id) ?? []), validation: current.validation, counts: current.counts, proposalRefs: operations.slice(0, 100).map(op => op.ref) },
    });
    const types = new Map(shown.types.map((type) => [type.id, type.title]));
    const names = nameIndex(graph, operations);
    const bulk = bulkActions(current, draw);
    const view = proposedView(graph, operations);
    const proposalLinks = new Map(operations.filter(op => op.operation.type === "graph-node" && ["pending", "awaiting_review"].includes(op.state)).map(op => [recordIdOf(op), `#${proposalAnchor(op)}`]));
    const nodeTypes = new Map(view.nodes.map(node => [node.id, node.typeId]));
    const viewer = view.nodes.length
      ? createKnowledgeGraphViewer(shown, view, view.nodes[0], { initialScale: 0.85, nodeHref: (id) => proposalLinks.get(id) ?? entityUrl(id, nodeTypes.get(id)), onError: (error) => root.appendChild(el("p", { role: "alert" }, `Unable to arrange graph: ${String(error)}`)) })
      : null;
    const groups = (["awaiting_review", "committed", "rejected", "pending"] as const)
      .map((state) => [state, operations.filter((op) => op.state === state)] as const)
      .filter(([, ops]) => ops.length);
    const panels = {
      graph: el("div", { id: "batch-graph", class: "change-graph" }, viewer ?? el("p", {}, "No graph nodes in this batch.")),
      proposals: el("div", { id: "batch-proposals" }, ...groups.map(([state, ops]) => el("div", { class: "change-proposal-group" },
        el("h2", {}, `${opLabels[state] ?? state} (${ops.length})`),
        el("ul", { class: "change-operations" }, ...ops.map(op => operationRow(current, op, names, types, draw)))))),
      review: el("div", { id: "batch-review" }, anchorSection(graph, current, draw), reviewSection(current, draw)),
    };
    const buttons = new Map<string, HTMLButtonElement>();
    const choose = (key: string) => {
      activeView = key;
      for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== key;
      for (const [name, button] of buttons) button.setAttribute("aria-pressed", String(name === key));
    };
    const tabs = el("nav", { class: "change-views", "aria-label": "Change batch views" }, ...[
      ["graph", `Graph (${view.nodes.length})`], ["proposals", `Proposals (${operations.length})`], ["review", "Review & anchors"],
    ].map(([key, label]) => {
      const button = el("button", { type: "button", "aria-controls": `batch-${key}`, onclick: () => choose(key) }, label);
      buttons.set(key, button); return button;
    }));
    viewer?.addEventListener("click", event => {
      const link = (event.target as Element).closest("a");
      if (link?.getAttribute("href")?.startsWith("#proposal-")) choose("proposals");
    });
    choose(activeView);
    fill(root,
      el("p", {}, el("a", { href: appUrl("changes") }, "← All changes")),
      el("h2", {}, batch.title),
      el("p", { class: "change-meta" }, `${stateLabels[batch.state] ?? batch.state} · ${time(batch.createdAt)}`),
      el("details", { class: "change-description" }, el("summary", {}, "Batch summary"),
        el("p", { class: "change-summary" }, batch.summary?.text ?? summaryLine(batch.summary) ?? ""),
        batch.summary?.text && summaryLine(batch.summary) ? el("p", { class: "change-meta" }, summaryLine(batch.summary)) : null),
      deadlineText(batch) ? el("p", { class: "change-deadline", role: "status" }, deadlineText(batch)) : null,
      bulk,
      current.validation ? el("p", { class: "change-validation", role: "status" }, current.validation.valid ? "Passing · Current proposals satisfy graph and anchor checks." : `Needs changes · ${current.validation.error}`) : null,
      tabs, ...Object.values(panels),
    );
  };
  draw(detail);
  livePoll(signal, async () => {
    if (root.querySelector("form:focus-within")) return;
    const next = await call<BatchDetail>(`batches/get?id=${encodeURIComponent(batchId)}`);
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
