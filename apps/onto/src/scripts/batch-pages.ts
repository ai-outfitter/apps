import { addressIndex } from "../lib/addresses";
import type { Graph, GraphEdge, GraphNode, TypeDefinition } from "../lib/graph";
import { appUrl, call, el, typeSegment } from "./data";

// A batch read as pages: every proposal opens on the page its record will have,
// marked "Proposed in <batch>, not saved". Changes lists the batch; these
// helpers build the walk order, the proposed records and one proposal's review.

export type Citation = { provider: string; recordId: string; uri?: string; quote?: string; observedAt?: string; version?: string };
export type Operation = { operation: "create" | "update"; type: "graph-type" | "graph-node" | "graph-edge"; ref: string; id?: string; attributes: Record<string, unknown> };
export type BatchOperation = {
  ref: string; operation: Operation; evidence: Citation[]; confidence: number | null; reason: string | null;
  state: string; decision: Record<string, unknown> | null; recordId: string | null;
};
export type Finding = { ref: string | null; rule: string; severity: "error" | "warning" | "note"; message: string; fix: string | null };
export type Review = {
  state: "complete" | "failed"; runId: string | null; prompt: { path: string; digest: string };
  startedAt: number; finishedAt: number; complete: boolean; summary: string; findings: Finding[]; error: string | null;
  decision?: { approved: number; held: { ref: string; reason: string }[]; at: number };
};
export type Batch = {
  id: string; title: string; purpose: string; state: string; reviewBy: number | null; createdAt: number; updatedAt: number;
  policy: { kind: string; threshold?: number }; source: { kind: string; ref: string; label?: string } | null;
  summary: { counts: Record<string, number>; evidence: number; operations: number; text: string | null } | null;
  counts?: Record<string, number>;
  anchors?: string[] | null;
  review: Review | null;
  questions?: Question[];
};
export type Question = { key: string; ask: string; refs: string[]; options?: string[]; answer?: { option?: string; text?: string; by: string; at: number } };
export type BatchDetail = { batch: Batch; counts: Record<string, number>; operations: BatchOperation[]; canReview: boolean; validation?: { valid: boolean; error: string | null; operations: number } };

/** One page in a batch's walk: a proposed type or node, or a saved node that only gains relationships. */
export type BatchItem = { kind: "type" | "node"; id: string; title: string; op: BatchOperation | null; edges: BatchOperation[] };

export const batchUrl = (id: string) => appUrl(`changes/${encodeURIComponent(id)}`);
export const getBatch = (id: string) => call<BatchDetail>(`batches/get?id=${encodeURIComponent(id)}`);
export const review = (batchId: string, verdict: "approve" | "reject", refs?: string[]) =>
  call<BatchDetail>("batches/review", { batchId, verdict, ...(refs ? { refs } : {}) });

export const waiting = (op: BatchOperation) => op.state === "pending" || op.state === "awaiting_review";
export const label = (op: BatchOperation) => String(op.operation.attributes.title ?? op.operation.attributes.name ?? op.ref);
export const proposalAnchor = (op: BatchOperation) => `proposal-${encodeURIComponent(op.ref).replaceAll("%", "_")}`;
export function recordIdOf(op: BatchOperation) {
  const id = op.operation.attributes.id;
  return op.recordId ?? (typeof id === "string" ? id : op.operation.id) ?? op.ref;
}

/** Operations with every address and `$ref` resolved to the record id it names. */
export function resolveOperations(graph: Graph, operations: BatchOperation[]) {
  const index = addressIndex(graph);
  const refs = new Map(operations.map((op) => [op.ref, recordIdOf(op)]));
  return operations.map((op) => {
    const operation = structuredClone(op.operation), a = operation.attributes;
    if (operation.id) operation.id = index[operation.type].get(operation.id) ?? operation.id;
    for (const field of ["typeId", "fromId", "toId"] as const) {
      const value = a[field];
      if (typeof value === "string") a[field] = refs.get(value) ?? index[field === "typeId" ? "graph-type" : "graph-node"].get(value) ?? value;
    }
    return { ...op, operation };
  });
}

/** The Wiki as if the batch's open proposals (and `include`, a rejected one being read) were saved, and which records are only proposed. */
export function proposedGraph(graph: Graph, operations: BatchOperation[], include?: string) {
  const open = operations.filter((op) => (waiting(op) || op.ref === include) && op.operation.operation === "create");
  const proposed = new Set(open.map(recordIdOf));
  const of = (type: Operation["type"]) => open.filter((op) => op.operation.type === type);
  const types: TypeDefinition[] = [...graph.types, ...of("graph-type").map((op) => ({
    properties: [], body: "", category: "node", ...op.operation.attributes, archived: false, id: recordIdOf(op), title: label(op),
  }) as unknown as TypeDefinition)];
  const nodes: GraphNode[] = [...graph.nodes, ...of("graph-node").map((op) => ({
    summary: "", body: "", website: null, properties: {}, source: null, revision: 0, createdBy: null, updatedBy: null, createdAt: 0, updatedAt: 0,
    ...op.operation.attributes, archived: false, id: recordIdOf(op), title: label(op),
  }) as unknown as GraphNode)];
  const edges: GraphEdge[] = [...graph.edges, ...of("graph-edge").map((op) => ({
    title: "", body: "", properties: {}, revision: 0, createdBy: null, updatedBy: null, createdAt: 0, updatedAt: 0,
    ...op.operation.attributes, archived: false, id: recordIdOf(op),
  }) as unknown as GraphEdge)];
  return { graph: { ...graph, types, nodes, edges, canEdit: false }, proposed };
}

/** Walk order: types, then nodes grouped by type, then saved nodes that only gain relationships. */
export function batchItems(view: Graph, operations: BatchOperation[]): BatchItem[] {
  // An update names its record by id; it reads by the saved title unless it changes it.
  const savedTitle = (op: BatchOperation) => op.operation.operation === "update" && !op.operation.attributes.title && !op.operation.attributes.name
    ? [...view.types, ...view.nodes].find((record) => record.id === recordIdOf(op))?.title : undefined;
  const item = (kind: BatchItem["kind"], op: BatchOperation): BatchItem => ({ kind, id: recordIdOf(op), title: savedTitle(op) ?? label(op), op, edges: [] });
  const types = operations.filter((op) => op.operation.type === "graph-type").map((op) => item("type", op));
  const typeOf = (op: BatchOperation) => String(op.operation.attributes.typeId ?? view.nodes.find((node) => node.id === recordIdOf(op))?.typeId ?? "");
  const groups = new Map<string, BatchItem[]>();
  for (const op of operations.filter((op) => op.operation.type === "graph-node"))
    groups.set(typeOf(op), [...(groups.get(typeOf(op)) ?? []), item("node", op)]);
  const nodes = [...groups.values()].flat(), saved: BatchItem[] = [];
  for (const op of operations.filter((op) => op.operation.type === "graph-edge")) {
    const { fromId, toId } = op.operation.attributes as { fromId: string; toId: string };
    let home = nodes.find((node) => node.id === fromId) ?? nodes.find((node) => node.id === toId) ?? saved.find((node) => node.id === fromId);
    if (!home) {
      home = { kind: "node", id: fromId, title: view.nodes.find((node) => node.id === fromId)?.title ?? fromId, op: null, edges: [] };
      saved.push(home);
    }
    home.edges.push(op);
  }
  return [...types, ...nodes, ...saved];
}

/** Whether the id in a page's URL names this item: its record id or, before it is saved, its ref. */
export const itemMatches = (item: BatchItem, id: string) =>
  item.id === id || (!!item.op && [item.op.ref, item.op.recordId, item.op.operation.attributes.id, item.op.operation.id].includes(id));

/** The item's page: the record's own route, opened from the batch. */
export function itemUrl(batchId: string, view: Graph, item: BatchItem) {
  const query = `?batch=${encodeURIComponent(batchId)}`;
  if (item.kind === "type") return appUrl(`types/${encodeURIComponent(item.id)}${query}`);
  const typeId = item.op?.operation.attributes.typeId ?? view.nodes.find((node) => node.id === item.id)?.typeId;
  const type = view.types.find((t) => t.id === typeId);
  return appUrl(`${type ? typeSegment(type.name) : "entities"}/${encodeURIComponent(item.id)}${query}`);
}

/** Titles for records and refs, so relationships read as names. */
export function nameIndex(view: Graph) {
  return new Map<string, string>(view.nodes.map((node) => [node.id, node.title]));
}
export function edgeTitle(op: BatchOperation, names: Map<string, string>, types: Map<string, string>) {
  const a = op.operation.attributes;
  const end = (value: unknown) => names.get(String(value)) ?? "an existing entity";
  return `${end(a.fromId)} → ${types.get(String(a.typeId)) ?? "related to"} → ${end(a.toId)}`;
}

/** A proposal's one-line summary: its summary, or the first paragraph of its body. */
export function lineSummary(op: BatchOperation) {
  const a = op.operation.attributes;
  if (typeof a.summary === "string" && a.summary.trim()) return a.summary.trim();
  if (typeof a.body !== "string" || a.body.trim().startsWith("{")) return "";
  return a.body.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part && !part.startsWith("#")) ?? "";
}

const opLabels: Record<string, string> = { pending: "Collecting", awaiting_review: "Waiting", committed: "Saved", rejected: "Rejected" };
const policyReasons: Record<string, string> = {
  "first-run": "Created on the first run",
  "review-window": "Approved when the review window ended",
  confidence: "Approved automatically: high confidence",
};
/** Who or what approved a change, from its recorded decision. */
export function approvalLabel(decision: { kind?: unknown; reason?: unknown } | null, otherwise = "Approved by a member") {
  if (decision?.kind === "steward") return "Approved by the ontology steward";
  if (decision?.kind === "member") return "Approved by a member";
  if (decision?.kind === "policy") return policyReasons[String(decision.reason ?? "")] ?? policyReasons.confidence;
  return otherwise;
}
/** How a committed operation was approved, or its state. */
export function approvalText(op: BatchOperation) {
  if (op.state !== "committed") return opLabels[op.state] ?? op.state;
  return approvalLabel(op.decision as { kind?: string; reason?: string } | null);
}

const time = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
export function citation(item: Citation) {
  const source = `${item.provider} · ${item.recordId}${item.version ? ` (version ${item.version})` : ""}`;
  const answer = item.provider === "onto" ? /^batch:([0-9a-f-]{36})#/i.exec(item.recordId)?.[1] : undefined;
  return el("li", {},
    answer ? el("a", { href: `${batchUrl(answer)}#questions` }, source) : item.uri ? el("a", { href: item.uri, rel: "noreferrer noopener", target: "_blank" }, source) : el("span", {}, source),
    item.observedAt ? el("span", { class: "change-meta" }, ` · ${time(Date.parse(item.observedAt))}`) : null,
    item.quote ? el("blockquote", {}, item.quote) : null,
  );
}

const severityLabels: Record<Finding["severity"], string> = { error: "Error", warning: "Warning", note: "Note" };
export function findingList(findings: Finding[]) {
  if (!findings.length) return null;
  return el("ul", { class: "change-findings" }, ...findings.map((item) => el("li", { class: `change-finding change-finding-${item.severity}` },
    el("strong", {}, `${severityLabels[item.severity]} · ${item.rule}: `), item.message,
    item.fix ? el("p", { class: "change-meta" }, `Suggested fix: ${item.fix}`) : null)));
}
export const findingsFor = (detail: BatchDetail, ref: string) => detail.batch.review?.findings.filter((item) => item.ref === ref) ?? [];

/** Approve or Reject for the given proposals, then `done`. */
export function verdictLinks(detail: BatchDetail, refs: string[], done: (next: BatchDetail) => void) {
  return el("span", { class: "change-actions" }, ...(["approve", "reject"] as const).map((verdict) => {
    const button = el("button", { type: "button", class: verdict === "approve" ? "primary" : "" }, verdict === "approve" ? "Approve" : "Reject");
    button.onclick = async () => {
      button.disabled = true;
      try { done(await review(detail.batch.id, verdict, refs)); }
      catch (error) { button.disabled = false; button.parentElement?.appendChild(el("p", { role: "alert" }, String(error))); }
    };
    return button;
  }));
}

/** An agent's questions about the batch, at the top of its index. Answering approves nothing; questions close with the batch. */
export function questionSection(detail: BatchDetail, refLink: (op: BatchOperation) => HTMLAnchorElement, draw: (next: BatchDetail) => void) {
  const questions = detail.batch.questions ?? [];
  if (!questions.length) return null;
  return el("section", { id: "questions", class: "change-questions" },
    el("h2", {}, "Questions"),
    el("ul", {}, ...questions.map(question => questionItem(detail, question, draw, refLink))));
}

/** The questions that name any of these proposals, on their page. */
export function proposalQuestions(detail: BatchDetail, refs: string[], draw: (next: BatchDetail) => void) {
  const questions = (detail.batch.questions ?? []).filter(question => question.refs.some(ref => refs.includes(ref)));
  return questions.length ? el("ul", { class: "change-questions" }, ...questions.map(question => questionItem(detail, question, draw))) : null;
}

function questionItem(detail: BatchDetail, question: Question, draw: (next: BatchDetail) => void, refLink?: (op: BatchOperation) => HTMLAnchorElement) {
  const open = detail.canReview && ["open", "awaiting_review"].includes(detail.batch.state);
  const refs = refLink ? detail.operations.filter(op => question.refs.includes(op.ref)) : [];
  const answer = question.answer ? question.answer.option ?? question.answer.text : null;
  const form = open ? answerForm(detail, question, draw) : null;
  if (form && answer) form.hidden = true;
  const change = form && answer ? el("button", { type: "button", class: "change-link", onclick: () => { form.hidden = false; change?.remove(); } }, "Change") : null;
  const item = el("li", { class: "change-question" },
    el("p", {}, question.ask),
    refLink && refs.length ? el("p", { class: "change-meta" }, "About ", ...refs.flatMap((op, i) => [i ? ", " : "", refLink(op)])) : null,
    answer ? el("p", { class: "change-answer" }, el("span", { class: "change-meta" }, "Answer: "), answer, change ? " " : null, change) : open ? null : el("p", { class: "change-meta" }, "Not answered."),
    form);
  item.dataset.question = question.key;
  return item;
}

function answerForm(detail: BatchDetail, question: Question, draw: (next: BatchDetail) => void) {
  const send = async (body: { option?: string; text?: string }) => {
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) control.disabled = true;
    try { draw(await call<BatchDetail>("batches/answer", { batchId: detail.batch.id, key: question.key, ...body })); }
    catch (error) {
      for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) control.disabled = false;
      form.appendChild(el("p", { role: "alert" }, String(error)));
    }
  };
  const input = el("input", { type: "text", name: "answer", maxLength: 500, placeholder: question.options ? "Or type an answer" : "Type an answer", "aria-label": `Answer: ${question.ask}` });
  const form = el("form", { class: "change-answer-form" },
    ...(question.options ?? []).map(option => el("button", { type: "button", class: "change-link", onclick: () => send({ option }) }, option)),
    input);
  form.onsubmit = (event) => { event.preventDefault(); if (input.value.trim()) send({ text: input.value.trim() }); };
  return form;
}

/** The plain line under the title that says where this page comes from. */
export function proposedLine(detail: BatchDetail, item: BatchItem) {
  const batch = el("a", { href: `${batchUrl(detail.batch.id)}${item.op ? `#${proposalAnchor(item.op)}` : ""}` }, detail.batch.title);
  const op = item.op;
  const [before, after] = !op ? ["Relationships proposed in ", ", not saved"]
    : op.state === "committed" ? ["Saved from ", ""]
    : op.state === "rejected" ? ["Rejected in ", ""]
    : op.operation.operation === "update" ? ["Changes proposed in ", ", not saved"]
    : ["Proposed in ", ", not saved"];
  return el("p", { class: "batch-proposed-line" }, before, batch, after);
}

const shown = (value: unknown) => value === undefined || value === null || value === "" ? "Not recorded" : typeof value === "object" ? JSON.stringify(value) : String(value);
/** An update's fields beside the saved values they replace. */
function proposedChanges(op: BatchOperation, saved: Record<string, unknown> | undefined) {
  if (op.operation.operation !== "update") return null;
  const rows = Object.entries(op.operation.attributes).filter(([key]) => key !== "id").flatMap(([key, value]) =>
    key === "properties" && value && typeof value === "object"
      ? Object.entries(value).map(([name, next]) => [name, (saved?.properties as Record<string, unknown> | undefined)?.[name], next] as const)
      : [[key, saved?.[key], value] as const]);
  return el("section", { class: "node-section" }, el("h2", {}, "Proposed changes"),
    el("div", { class: "node-table-scroll" }, el("table", { class: "node-table batch-changes" },
      el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Field"), el("th", { scope: "col" }, "Saved"), el("th", { scope: "col" }, "Proposed"))),
      el("tbody", {}, ...rows.map(([key, before, after]) => el("tr", {}, el("td", {}, key), el("td", {}, shown(before)), el("td", { class: "batch-proposed" }, shown(after))))))));
}

function evidence(op: BatchOperation) {
  return op.evidence.length
    ? el("details", {}, el("summary", {}, `Evidence (${op.evidence.length})`), el("ul", { class: "change-evidence" }, ...op.evidence.map(citation)))
    : el("p", { class: "change-meta" }, "No evidence cited.");
}

/** One proposal's review on its page: state, reason, findings, evidence, its relationships and the walk. */
export function batchItemPanel(detail: BatchDetail, view: Graph, items: BatchItem[], item: BatchItem, done: (next: BatchDetail) => void) {
  const op = item.op;
  const canDecide = (target: BatchOperation) => detail.canReview && target.state === "awaiting_review";
  const names = nameIndex(view), types = new Map(view.types.map((type) => [type.id, type.title]));
  const saved = op?.operation.operation === "update"
    ? (op.operation.type === "graph-type" ? view.types : view.nodes).find((record) => record.id === item.id) as Record<string, unknown> | undefined
    : undefined;
  const at = items.indexOf(item), previous = items[at - 1], next = items[at + 1];
  return el("section", { class: "batch-item", "aria-label": "Proposal review" },
    op ? el("div", { class: "batch-item-decision" },
      el("span", { class: "change-state" }, approvalText(op)),
      op.confidence === null ? null : el("span", { class: "change-meta", title: "The producing agent's own confidence" }, `${Math.round(op.confidence * 100)}% confident`),
      canDecide(op) ? verdictLinks(detail, [op.ref], done) : null) : null,
    op?.reason ? el("p", {}, op.reason) : null,
    proposalQuestions(detail, [...(op ? [op.ref] : []), ...item.edges.map((edge) => edge.ref)], done),
    op ? findingList(findingsFor(detail, op.ref)) : null,
    op ? proposedChanges(op, saved) : null,
    op ? evidence(op) : null,
    item.edges.length ? el("div", { class: "batch-item-edges" }, el("h2", {}, "Proposed relationships"),
      el("ul", { class: "change-line-edges" }, ...item.edges.map((edge) => el("li", { id: proposalAnchor(edge) },
        el("span", {}, edgeTitle(edge, names, types)),
        el("span", { class: "change-state" }, approvalText(edge)),
        canDecide(edge) ? verdictLinks(detail, [edge.ref], done) : null,
        findingList(findingsFor(detail, edge.ref)))))) : null,
    el("nav", { class: "batch-item-nav", "aria-label": "Batch" },
      previous ? el("a", { href: itemUrl(detail.batch.id, view, previous), rel: "prev" }, `← Previous: ${previous.title}`) : el("span", {}),
      el("a", { href: batchUrl(detail.batch.id) }, "All proposals"),
      next ? el("a", { href: itemUrl(detail.batch.id, view, next), rel: "next" }, `Next: ${next.title} →`) : el("span", {})),
  );
}

/** Everything a page needs to show a record from a batch. */
export async function batchPageContext(graph: Graph, batchId: string, id: string) {
  const detail = await getBatch(batchId);
  const operations = resolveOperations(graph, detail.operations);
  let { graph: view, proposed } = proposedGraph(graph, operations);
  const items = batchItems(view, operations);
  const item = items.find((candidate) => itemMatches(candidate, id)) ?? null;
  if (item?.op?.state === "rejected") ({ graph: view, proposed } = proposedGraph(graph, operations, item.op.ref));
  const urls = new Map(items.map((candidate) => [candidate.id, itemUrl(batchId, view, candidate)]));
  return { detail, view, proposed, items, item, href: (record: string) => urls.get(record) };
}
/** The batch on its own, for its graph: proposed types, nodes and edges over the saved ones. */
export function proposedView(graph: Graph, ops: BatchOperation[]) {
  const live = ops.filter((op) => op.state !== "rejected");
  const of = (type: Operation["type"]) => live.filter((op) => op.operation.type === type);
  const types = new Map(graph.types.map((type) => [type.id, type]));
  for (const op of of("graph-type")) {
    const id = recordIdOf(op);
    types.set(id, { body: "", properties: [], archived: false, ...types.get(id), ...op.operation.attributes, id, title: label(op) } as Graph["types"][number]);
  }
  const nodes = new Map<string, GraphNode>();
  for (const op of of("graph-node")) {
    const id = recordIdOf(op), a = op.operation.attributes;
    const saved = graph.nodes.find((node) => node.id === id);
    nodes.set(id, { ...(saved ?? {}), id, typeId: String(a.typeId ?? saved?.typeId ?? ""), title: String(a.title ?? saved?.title ?? op.ref) } as GraphNode);
  }
  const edges: GraphEdge[] = [];
  for (const op of of("graph-edge")) {
    const a = op.operation.attributes, fromId = String(a.fromId), toId = String(a.toId);
    for (const end of [fromId, toId]) addSaved(graph, nodes, end);
    if (nodes.has(fromId) && nodes.has(toId))
      edges.push({ id: recordIdOf(op), typeId: String(a.typeId), fromId, toId, title: "", body: "", properties: {}, archived: false } as GraphEdge);
  }
  return { types: [...types.values()], nodes: [...nodes.values()], edges };
}
function addSaved(graph: Graph, nodes: Map<string, GraphNode>, id: string) {
  const saved = graph.nodes.find((node) => node.id === id);
  if (saved && !nodes.has(id)) nodes.set(id, saved);
}
