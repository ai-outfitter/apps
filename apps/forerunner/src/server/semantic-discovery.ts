import type { EvidenceItem } from "@ai-outfitter/app-sdk/evidence";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import type { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import type { OntologyContract } from "@ai-outfitter/app-sdk/graph-contracts";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { type AnalysisInput, analysisBatches } from "./analysis-batches";
import type { Operation, Proposal } from "./discovery";
import { type DiscoveryOntology, discoveryPrompt } from "./discovery-ontology";

export function analysisSchema(ontology: DiscoveryOntology) {
  const evidence = z.array(z.string().min(1).max(30)).min(1).max(5).describe("References to supplied source evidence, not invented citations");
  return z.strictObject({
    entities: z.array(z.strictObject({
      key: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).describe("Unique reference used verbatim in relationship from/to"),
      name: z.string().min(1).max(160).describe("Canonical name of the real-world subject. Reuse a supplied existing identity when supported."),
      type: z.enum(ontology.entities.map(t => t.name) as [string,...string[]]),
      summary: z.string().min(1).max(280).describe("Specific supported context; distinguish scheduled, inferred and observed."),
      existingId: z.uuid().nullable().describe("Supplied existing identity of this same type, otherwise null; matches are proposals for review"),
      certainty: z.enum(["mentioned", "inferred"]), confidence: z.number().min(0).max(1).optional().describe("Your own confidence, from 0 to 1, as the proposal rules define it."), evidence,
    })).max(16).describe("Prioritize direct personal contacts named in calendar invitations or correspondence, then concrete assets and obligations. A one-off meeting can identify a Person without becoming an entity itself. Do not reclassify events, meetings, activities or recurring series under other types. Include the operating user as an entity when a relationship refers to them. Source account identity cannot replace the trusted operating user identity."),
    relationships: z.array(z.strictObject({
      from: z.string().max(40).describe("Exact entities.key in this response, not a name, type or Wiki ID"), to: z.string().max(40).describe("Exact entities.key in this response, not a name, type or Wiki ID"),
      type: ontology.relationships.length ? z.enum(ontology.relationships.map(t => t.name) as [string,...string[]]) : z.never(),
      reason: z.string().min(1).max(240), confidence: z.number().min(0).max(1).optional().describe("Your own confidence, from 0 to 1, as the proposal rules define it."), evidence,
    })).max(18).describe("All endpoints, including the operating user and existing nodes, must appear in entities. Relationships must follow ontology source and target types. Unspecified endpoint types have no supported pairing. Omit uncertain ownership when the source account cannot be matched to a named person; never substitute the operating user for the source account owner."),
  });
}
type Analysis = z.infer<ReturnType<typeof analysisSchema>>;
export type Sample = { provider: string; account: string; accountId?: string; collectedAt: string; records: { id: string; title: string; text: string; date: string; url?: string; participants: string[]; recordId?: string; version?: string }[] };
export type Graph = Awaited<ReturnType<typeof readWikiGraph>>;
/** A UUID-shaped id derived from `value`; stored record ids depend on this exact shape. */
export async function stableId(value: string) {
  const h = await sha256Hex(value);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

/** How much of each item the model reads: a whole ordinary email, without the quoted thread. */
export const excerptLimit = 3000;
/** `identity` anchors stable record ids; `recordId` is how a citation names the source, as a chat agent would. */
type Evidence = { identity: string; recordId: string; title: string; excerpt: string; url?: string; provider?: string; subject?: string; participants?: string[]; date?: string; account?: string; version?: string };
/** One source record exactly as the model saw it, under the ref its answer cites. */
export type RunInput = { ref: string; provider: string; account: string; subject: string; date: string; participants: string[]; excerpt: string; url?: string };
function prepareEvidence(samples: Sample[], user: { id: string; name: string; email: string }) {
  const refs = new Map<string, Evidence>();
  const records = samples.flatMap(sample => sample.records.map(record => ({ sample, record }))).slice(0,40);
  for (const { sample, record } of records) refs.set(`e${refs.size}`, {
    identity: JSON.stringify([sample.provider, sample.accountId ?? sample.account, record.id]),
    // GitHub and Slack name their own record ids; Gmail and Calendar cite <account>/<id>.
    recordId: `${sample.account}/${record.id}`,
    provider: sample.provider, subject: record.title, participants: record.participants, date: record.date, account: sample.account,
    title: `${record.title.slice(0,160)} · ${record.date.slice(0,40)} · ${sample.provider} · ${sample.account.slice(0,128)}`,
    excerpt: `${record.participants.length ? `Participants as supplied: ${record.participants.slice(0,4).join(", ")}\n` : ""}${record.text}`.slice(0,excerptLimit), url: record.url,
    ...(record.recordId ? { recordId: record.recordId } : {}), ...(record.version ? { version: record.version } : {}),
  });
  refs.set("operating-user", { identity: JSON.stringify(["platform-user", user.id]), recordId: user.id, title: "Authenticated platform identity", excerpt: `Name: ${user.name}\nEmail: ${user.email}` });
  return refs;
}

/** Keep local model keys isolated, while preserving a separate unfiltered history. */
function appendAnalysis(target: Analysis, answer: Analysis, prefix: string) {
  target.entities.push(...answer.entities.map(entity => ({ ...entity, key: prefix + entity.key })));
  target.relationships.push(...answer.relationships.map(relation => ({ ...relation, from: prefix + relation.from, to: prefix + relation.to })));
}

export async function semanticProposal(host: WorkflowHost<"interactive">, graph: Graph, samples: Sample[], ontology: DiscoveryOntology, user: { id: string; name: string; email: string }, diagnostic: (event: Record<string, unknown>) => Promise<void> = async () => {}, options: { runId?: string; taskId?: string; selection?: unknown; instructions?: string; batchBudget?: number; onlyBatch?: number; batches?: AnalysisInput[] } = {}) {
  const types = new Map(graph.types.map(t => [String(t.attributes.name), t]));
  const analysis = analysisSchema(ontology);
  const instructions = options.instructions ?? discoveryPrompt(user, ontology);
  const refs = prepareEvidence(samples, user);
  const sourceText = [...refs.values()].map(e => `${e.title} ${e.excerpt}`).join(" ").toLowerCase();
  const candidates = graph.nodes.filter(n =>
    !n.attributes.archived && ontology.entities.some(t => t.id === n.attributes.typeId) &&
    sourceText.includes(String(n.attributes.title).toLowerCase())
  ).slice(0,80);
  const input = {
    evidence: [...refs].map(([ref, value]) => ({ ref, title: value.title, excerpt: value.excerpt })),
    existing: candidates.map(n => ({ id: n.ref.id, name: String(n.attributes.title).slice(0,160), type: [...types].find(([,t]) => t.ref.id === n.attributes.typeId)?.[0] ?? "" })),
    limits: `A batch from the first 40 records, excerpts at most ${excerptLimit} characters, first 80 relevant existing nodes. Do not infer from omitted content.`,
  };
  const run = await analysisRun(host, options);
  const output: Analysis = { entities: [], relationships: [] };
  const rawOutput: Analysis = { entities: [], relationships: [] };
  const existingIds = candidates.length ? z.enum(candidates.map(n => n.ref.id) as [string, ...string[]]).nullable() : z.null();
  const warnings: string[] = [];
  try {
    const checkpoint = async (id: string, parentId: string | null, data: unknown) => host.call("session.append", {runId:run.id,entry:{id,parentId,kind:"checkpoint",step:"analyze",at:new Date().toISOString(),data:JSON.parse(JSON.stringify(data))}});
    await diagnostic({status:"analyzing",workflowRunId:run.id});
    await checkpoint("analysis",null,{adapter:"forerunner-analysis-v1",graph,samples,ontology,user,selection:options.selection ?? null,limits:{records:40,excerpt:excerptLimit},instructions});
    const batches = options.batches ?? analysisBatches(input,options.batchBudget);
    await diagnostic({ status: "analyzing", workflowRunId: run.id, systemPrompt: instructions, input, analysisBatchCount: batches.length, analysisBatchesCompleted: 0 });
    // Sequential calls bound provider pressure and keep diagnostics ordered. Nothing is saved until all succeed.
    for (const [index, data] of selectedBatches(batches,options.onlyBatch)) {
      const batchRefs = new Map(data.evidence.map(e => [e.ref, need(refs, e.ref)]));
      const cited = z.array(z.enum([...batchRefs.keys()] as [string, ...string[]])).min(1).max(5);
      const resultSchema = analysis.extend({
        entities: z.array(analysis.shape.entities.element.required({ confidence: true }).extend({ evidence: cited, existingId: existingIds })).max(16),
        relationships: z.array(analysis.shape.relationships.element.required({ confidence: true }).extend({ evidence: cited })).max(18),
      });
      const schema = z.record(z.string(), z.json()).parse(z.toJSONSchema(resultSchema));
      await diagnostic({ status: "analyzing", schema, analysisBatch: index + 1 });
      await checkpoint(`analysis.batch.${index}`,"analysis",{batch:index,data,schema});
      const response = await host.call("inference.generate", { runId: run.id, step: "analyze", checkpointId:`analysis.batch.${index}`, instructions, data, schema });
      const answer = analysis.parse(response.output);
      // Validate before filters can hide duplicate keys or unsupported citations.
      validateAnalysis({ ...answer, relationships: [] }, batchRefs, candidates, ontology);
      const prefix = batches.length === 1 ? "" : `b${index}_`;
      appendAnalysis(rawOutput, answer, prefix);
      warnings.push(...retainNamedEntities(answer, batchRefs), ...retainValidRelationships(answer, batchRefs, candidates, ontology));
      validateIdentityTypes(answer,candidates,types);
      // Model-local keys may repeat. Keep separate anchors separate; only explicit Wiki IDs resolve together.
      appendAnalysis(output, answer, prefix);
      await diagnostic({ status: "analyzing", analysisBatchesCompleted: index + 1 });
    }
    await diagnostic({ status: "validating", output: rawOutput });
  } catch (error) {
    await run.collect({ status: "failed", entries: 0 });
    if (error instanceof Response) throw error;
    throw new Response(analysisFailure(error), { status: 422 });
  }
  const proposal = await proposalChanges(graph, types, refs, output);
  await host.call("session.append",{runId:run.id,entry:{id:"analysis.result",parentId:"analysis",kind:"result",step:"analyze",at:new Date().toISOString(),data:JSON.parse(JSON.stringify({...proposal,output:rawOutput,warnings}))}});
  await run.collect({ status: "ready", entries: proposal.entries.length });
  return { ...proposal, inputs: runInputs(refs), systemPrompt: instructions, warnings };
}

/** Tasks own their claim and completion; ordinary previews retain analysis-only runs. */
async function analysisRun(host: WorkflowHost<"interactive">, options: {runId?: string; taskId?: string}) {
  if (options.taskId) return { id: options.taskId, collect: async (_value: {status:string;entries:number}) => {} };
  const run = await host.call("workflow.start", {workflow:"forerunner-discovery",id:options.runId ?? crypto.randomUUID(),inputs:{}});
  return { id: run.id, collect: (value: {status:string;entries:number}) => host.call("workflow.collect", {runId:run.id,slot:"analyze.outputs.result",value}) };
}

/** The records a run read, for the run page's per-email view. */
function runInputs(refs: Map<string, Evidence>): RunInput[] {
  return [...refs].filter(([ref]) => ref !== "operating-user").map(([ref, e]) => ({
    ref, provider: e.provider ?? "", account: e.account ?? "", subject: e.subject ?? e.title, date: e.date ?? "",
    participants: e.participants ?? [], excerpt: e.excerpt, ...(e.url ? { url: e.url } : {}),
  }));
}

/** Why analysis failed, in words a member can act on; never the model's text. */
function analysisFailure(error: unknown) {
  if (error instanceof z.ZodError) return "The model's answer did not match the proposal format. Run discovery again.";
  if (error instanceof Error && /Model returned|Identity match/.test(error.message)) return error.message;
  return `Analysis failed${error instanceof Error ? ` (${error.name})` : ""}. Run discovery again; your previous preview is kept.`;
}

function need<T>(map: Map<string,T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing validated reference: ${key}`);
  return value;
}
async function relationshipIdentity(graph: Graph, type: Graph["types"][number], fromId: string, toId: string) {
  const contract = type.attributes.ontology as OntologyContract | undefined;
  const symmetric = contract?.version === 2 && contract.symmetric;
  const existing = graph.edges.find(edge => !edge.attributes.archived && edge.attributes.typeId === type.ref.id &&
    ((edge.attributes.fromId === fromId && edge.attributes.toId === toId) ||
     (symmetric && edge.attributes.fromId === toId && edge.attributes.toId === fromId)));
  const pair = symmetric ? [fromId, toId].sort() : [fromId, toId];
  return existing?.ref.id ?? await stableId(JSON.stringify([pair[0], String(type.attributes.name), pair[1]]));
}

async function proposalChanges(graph: Graph, types: Map<string, Graph["types"][number]>, refs: Map<string,Evidence>, output: Analysis) {
  const operations: Operation[] = [];
  const proposals: Proposal[] = [];
  type Entry = { id: string; typeId: string; title: string; kind: string; existing: boolean; excerpt: string; modelKeys: string[] };
  const entries = new Map<string, Entry>();
  // Keep the first staged summary and evidence; every model alias links to that same entry.
  const addEntry = (entry: Omit<Entry, "modelKeys">, key: string) => {
    const previous = entries.get(entry.id);
    if (previous) previous.modelKeys.push(key);
    else entries.set(entry.id, { ...entry, modelKeys: [key] });
  };
  const known = new Set([...graph.nodes, ...graph.edges].map(n => n.ref.id));
  const ids = new Map<string,string>();
  const entities = new Map(output.entities.map(e => [e.key,e]));
  const evidenceText = (keys: string[]) => keys.map(key => {
    const item = need(refs, key);
    return `${item.title}\nSource identity: ${item.identity}\n${item.url ? `Source: ${item.url}\n` : ""}Excerpt (untrusted): ${item.excerpt}`;
  }).join("\n\n");
  const add = (type: Operation["type"], id: string, attributes: Operation["attributes"], meta: { evidence: string[]; confidence: number; reason: string }) => {
    if (known.has(id)) return;
    const ref = `$change${operations.length}`;
    operations.push({ operation: "create", type, ref, attributes: { id, ...attributes } });
    proposals.push({ ref, evidence: meta.evidence.map(key => citation(need(refs, key))), confidence: meta.confidence, reason: meta.reason });
    known.add(id);
  };
  for (const entity of output.entities) {
    const anchors = entity.evidence.map(e => need(refs, e).identity).sort();
    const id = entity.existingId ?? await stableId(JSON.stringify([graph.wiki.installationId, entity.type, entity.name.toLowerCase(), anchors]));
    ids.set(entity.key, id);
    // The preview shows the evidence; the Wiki record keeps the summary, and the batch keeps the citations.
    const excerpt = `Forerunner proposal: ${entity.certainty}. ${entity.existingId ? "Proposed identity match; existing page is unchanged." : "Review before treating implications as facts."}\n\n${entity.summary}\n\nEvidence:\n${evidenceText(entity.evidence)}`;
    addEntry({ id, typeId: need(types, entity.type).ref.id, title: entity.name, kind: entity.type, existing: !!entity.existingId || known.has(id), excerpt }, entity.key);
    if (!entity.existingId) add("graph-node", id, { typeId: need(types, entity.type).ref.id, title: entity.name, body: entity.summary }, { evidence: entity.evidence, confidence: reported(entity), reason: entity.summary });
  }
  for (const relation of output.relationships) {
    const fromId = need(ids, relation.from), toId = need(ids, relation.to);
    // Different model keys can resolve to the same Wiki person.
    if (fromId === toId) continue;
    const id = await relationshipIdentity(graph, need(types, relation.type), fromId, toId);
    const excerpt = `Proposed relationship; not a confirmed fact.\n${relation.reason}\n\nEvidence:\n${evidenceText(relation.evidence)}`;
    const title = `${need(entities, relation.from).name} → ${relation.type} → ${need(entities, relation.to).name}`;
    addEntry({ id, typeId: need(types, relation.type).ref.id, title, kind: "Proposed relationship", existing: known.has(id), excerpt }, JSON.stringify([relation.from, relation.type, relation.to]));
    add("graph-edge", id, { typeId: need(types, relation.type).ref.id, fromId, toId, body: relation.reason }, { evidence: relation.evidence, confidence: reported(relation), reason: relation.reason });
  }
  // Saving stages operations in groups of 100; that transport limit is not a preview limit.
  return { operations, entries: [...entries.values()], proposals };
}

/** The model's own confidence. Without one, a cautious default that never auto-accepts. */
export function reported(item: { confidence?: number; certainty?: "mentioned" | "inferred" }) {
  return item.confidence ?? (item.certainty === "mentioned" ? 0.8 : 0.6);
}

/** One supplied source as a shared evidence citation (@ai-outfitter/app-sdk/evidence). */
export function citation(item: Evidence): EvidenceItem {
  return {
    provider: (item.provider ?? "platform-user").slice(0, 100),
    recordId: item.recordId.slice(0, 500),
    ...(item.version ? { version: item.version.slice(0, 200) } : {}),
    ...(item.url && /^https?:\/\//.test(item.url) ? { uri: item.url } : {}),
    quote: item.excerpt.slice(0, 2000),
    // A calendar event's date is when it happens, not when it was seen.
    ...(item.provider === "google-calendar" ? {} : observedAt(item.date)),
  };
}

/** A message's own date as an ISO timestamp, when it parses. */
function observedAt(date: string | undefined): { observedAt?: string } {
  const time = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(time) ? { observedAt: new Date(time).toISOString() } : {};
}

export function validateAnalysis(output: Analysis, refs: Map<string, unknown>, candidates: Graph["nodes"], ontology: DiscoveryOntology) {
  const keys = new Set(output.entities.map(e => e.key));
  if (keys.size !== output.entities.length) throw new Error("Model returned duplicate entity keys; retry preview.");
  for (const row of [...output.entities, ...output.relationships])
    if (row.evidence.some(ref => !refs.has(ref))) throw new Error("Model returned unsupported evidence; retry preview.");
  for (const entity of output.entities)
    if (entity.existingId && !candidates.some(n => n.ref.id === entity.existingId)) throw new Error("Model returned an unknown identity match; retry preview.");
  for (const relation of output.relationships) {
    if (!keys.has(relation.from) || !keys.has(relation.to) || relation.from === relation.to) throw new Error("Model returned invalid relationship endpoints; retry preview.");
    const definition = ontology.relationships.find(t => t.name === relation.type);
    const from = output.entities.find(e => e.key === relation.from), to = output.entities.find(e => e.key === relation.to);
    if (!definition || !from || !to || !definition.from.includes(from.type) || !definition.to.includes(to.type)) throw new Error("Model returned relationship endpoint types outside the live ontology; retry preview.");
  }

}

function calendarOnlyUnsupported(entity: Analysis["entities"][number], refs: Map<string, Evidence>) {
  if (entity.existingId) return false;
  const evidence = entity.evidence.map(key => refs.get(key));
  if (!evidence.length || !evidence.every(item => item?.provider === "google-calendar")) return false;
  if (entity.type !== "Person") return true;
  const name = entity.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`(^|[^\\p{L}\\p{N}])${name}([^\\p{L}\\p{N}]|$)`, "iu");
  return !evidence.some(item => [item?.subject ?? "", ...(item?.participants ?? [])].some(value => named.test(value)));
}
function retainNamedEntities(output: Analysis, refs: Map<string, Evidence>) {
  const removed = new Set(output.entities.filter(entity => entity.type === "Person" &&
    /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(entity.name.trim())).map(entity => entity.key));
  const warnings = removed.size ? ["Omitted email-only Person proposals and their relationships. A mailbox needs a supported named identity; account metadata alone does not establish one."] : [];
  const calendarOnly = output.entities.filter(entity => calendarOnlyUnsupported(entity, refs));
  if (calendarOnly.length) warnings.push("Omitted calendar-only proposals beyond named contacts. Events and public speakers stay as source evidence; other new entities need corroboration from another source.");
  for (const entity of calendarOnly) removed.add(entity.key);
  output.entities = output.entities.filter(entity => !removed.has(entity.key));
  output.relationships = output.relationships.filter(relation => !removed.has(relation.from) && !removed.has(relation.to));
  return warnings;
}

function retainValidRelationships(output: Analysis, refs: Map<string, unknown>, candidates: Graph["nodes"], ontology: DiscoveryOntology) {
  validateAnalysis({ ...output, relationships: [] }, refs, candidates, ontology);
  const warnings: string[] = [];
  output.relationships = output.relationships.filter(relation => {
    try {
      validateAnalysis({ ...output, relationships: [relation] }, refs, candidates, ontology);
      return true;
    } catch {
      warnings.push(`Omitted proposed ${relation.type}: its evidence or directed endpoints do not match the loaded graph and ontology.`);
      return false;
    }
  });
  return warnings;
}

function selectedBatches(batches:AnalysisInput[],onlyBatch:number|undefined){
  if(onlyBatch!==undefined&&!batches[onlyBatch])throw new Error("Selected batch does not exist");
  return [...batches.entries()].filter(([index])=>onlyBatch===undefined||onlyBatch===index);
}
function validateIdentityTypes(answer:Analysis,candidates:Graph["nodes"],types:Map<string,Graph["types"][number]>){
      for (const entity of answer.entities)
        if (entity.existingId && !candidates.some(n => n.ref.id === entity.existingId && n.attributes.typeId === need(types, entity.type).ref.id)) throw new Error("Identity match has a different Wiki type; retry preview.");

}
