import { z } from "zod";
import { entityRef, type EntityRecord, type EntityRef } from "./entities";
import { graphMarkdownBytes, graphMarkdownVersion, graphReference } from "./graph-markdown";
import { knowledgeGraphSelectFields, knowledgeGraphSelectResult, oneDefinition, oneDefinitionMessage } from "./graph-selection";
import type { WorkflowHost } from "./workflow-host";

const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).refine(value => !["constructor", "prototype"].includes(value));
const expression = z.json();
export const graphTemplateSchema = z.strictObject({
  version: z.literal(1),
  order: z.number().int().min(0).max(100),
  name: z.string().min(1).max(200),
  bindings: z.record(key, expression).refine(value => Object.keys(value).length <= 40),
  require: z.array(expression).max(16).default([]),
  sections: z.array(z.strictObject({
    heading: expression, level: z.number().int().min(1).max(4).default(2),
    rows: expression.optional(), content: expression.optional(),
    fields: z.array(z.strictObject({ label: z.string().min(1).max(120), value: expression, missing: z.string().max(500).optional() })).max(32).default([]),
  })).min(1).max(24),
});
export type GraphTemplate = z.infer<typeof graphTemplateSchema>;
type Value = unknown;
type View = Record<string, unknown>;
const list = (value: Value): Value[] => value == null ? [] : Array.isArray(value) ? value : [value];
const object = (value: Value): View => value !== null && typeof value === "object" && !Array.isArray(value) ? value as View : {};
const own = (value: Value, field: string) => Object.hasOwn(object(value), field) ? object(value)[field] : undefined;
const id = (value: Value) => typeof value === "object" && value !== null ? own(value, "id") : value;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const heading = (value: string) => value.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]<>()#!|]/g, "\\$&");
function canonical(value: Value): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort(compare).map(k => `${JSON.stringify(k)}:${canonical(own(value, k))}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const text = (value: Value): string => value == null ? "" : typeof value === "object" ? canonical(value) : String(value);
const bytes = (value: string) => new TextEncoder().encode(value).length;

type GraphInput = {
  installationId: string; types: EntityRecord[]; nodes: EntityRecord[]; edges: EntityRecord[];
  /** Stored templates carry their record (cited as a source); an app's own template has none. */
  templates: Array<{ record?: EntityRecord; definition: unknown }>;
  parameters: Record<string, unknown>; maxBytes?: number;
};
function view(record: EntityRecord): View {
  let data: unknown = null;
  try { data = JSON.parse(String(record.attributes.body)); } catch { /* Keep authored Markdown in body. */ }
  return { ...record.attributes, id: record.ref.id, title: record.title, revision: record.revision, ref: record.ref, data };
}
function nodeIndex(input: GraphInput) {
  const nodes = new Map<string,View>(), byType = new Map<string,View[]>();
  const types = new Map(input.types.map(type => [type.ref.id,type]));
  for (const record of [...input.nodes].sort((a,b) => compare(graphReference(a.ref),graphReference(b.ref)))) {
    if (record.attributes.archived) continue;
    const node = view(record), name = String(types.get(String(record.attributes.typeId))?.attributes.name ?? "");
    nodes.set(record.ref.id,node);
    byType.set(name,[...(byType.get(name) ?? []),node]);
  }
  return {nodes,byType,types};
}
function edgeIndex(input: GraphInput, types: Map<string,EntityRecord>) {
  const links = new Map<string,Array<{target:string;edge:EntityRecord}>>();
  for (const edge of [...input.edges].sort((a,b) => compare(graphReference(a.ref),graphReference(b.ref)))) {
    if (edge.attributes.archived) continue;
    const name = String(types.get(String(edge.attributes.typeId))?.attributes.name ?? "");
    const from = String(edge.attributes.fromId), to = String(edge.attributes.toId);
    for (const [source,target,direction] of [[from,to,"out"],[to,from,"in"]]) {
      const key = JSON.stringify([source,name,direction]);
      links.set(key,[...(links.get(key) ?? []),{target,edge}]);
    }
  }
  return links;
}
class Evaluation {
  readonly sources = new Map<string,EntityRecord>();
  readonly unresolved = new Map<string,EntityRef>();
  readonly index: ReturnType<typeof nodeIndex>;
  readonly links: ReturnType<typeof edgeIndex>;
  readonly records: Map<string,EntityRecord>;
  operations = 0;
  constructor(readonly input: GraphInput) {
    this.index = nodeIndex(input);
    this.links = edgeIndex(input,this.index.types);
    this.records = new Map(input.nodes.map(record => [record.ref.id,record]));
  }
  note(record: EntityRecord) { this.sources.set(graphReference(record.ref),record); }
  found(identity: unknown) {
    const node = this.index.nodes.get(String(identity));
    const record = this.records.get(String(identity));
    if (node && record) this.note(record);
    else if (typeof identity === "string" && identity) {
      const ref = {installationId:this.input.installationId,type:"graph-node",id:identity};
      this.unresolved.set(graphReference(ref),ref);
    }
    return node;
  }
  reference(target: Value) {
    const result = list(target).map(value => this.found(id(value)));
    return Array.isArray(target) ? result : result[0];
  }
  related(expr: View, env: View, depth: number) {
    const result = new Map<string,View>();
    for (const source of list(this.evaluate(expr.from,env,depth))) {
      const key = JSON.stringify([id(source),expr.edge,expr.direction ?? "out"]);
      for (const link of this.links.get(key) ?? []) {
        const node = this.found(link.target); this.note(link.edge);
        if (node) result.set(link.target,node);
      }
    }
    return [...result].sort(([a],[b]) => compare(a,b)).map(([,value]) => value);
  }
  query(expr: View, env: View, depth: number) {
    return (this.index.byType.get(String(expr.type)) ?? []).filter(node => {
      const previous = new Map(this.sources), missing = new Map(this.unresolved);
      const matches = list(expr.where).every(condition => this.evaluate(condition,{...env,item:node},depth));
      if (matches) this.found(node.id);
      else {
        this.sources.clear(); for (const [key,value] of previous) this.sources.set(key,value);
        this.unresolved.clear(); for (const [key,value] of missing) this.unresolved.set(key,value);
      }
      return matches;
    });
  }
  evaluate(value: Value, env: View, depth = 0): Value {
    if (++this.operations > 100_000 || depth > 24) throw new Response("Graph template evaluation bounds exceeded", {status:413});
    if (typeof value === "string" && value.startsWith("$"))
      return value.slice(1).split(".").reduce<Value>((result,part) => own(result,part),env);
    const expr = object(value);
    if (!Object.hasOwn(expr,"op")) return value;
    const ev = (field:string) => this.evaluate(expr[field],env,depth + 1);
    switch (expr.op) {
      case "ref": return this.reference(ev("id"));
      case "related": return this.related(expr,env,depth + 1);
      case "query": return this.query(expr,env,depth + 1);
      case "map": return list(ev("from")).map(item => this.evaluate(expr.value,{...env,[String(expr.as ?? "item")]:item},depth + 1));
      case "join": return list(ev("from")).filter(value => value != null).map(text).join(String(expr.separator ?? "; "));
      case "concat": return list(expr.parts).map(part => text(this.evaluate(part,env,depth + 1))).join("");
      case "contains": return list(ev("in")).some(value => id(value) === id(ev("value")));
      case "eq": return id(ev("left")) === id(ev("right"));
      case "present": return ev("value") != null;
      default: throw new Response("Unsupported graph template operation",{status:409});
    }
  }
  field(field: GraphTemplate["sections"][number]["fields"][number], env: View) {
    let value = this.evaluate(field.value,env);
    if (value == null || value === "" || Array.isArray(value) && value.length === 0) value = field.missing;
    if (value === undefined) return [];
    if (Array.isArray(value)) return [`- ${field.label}:`,...value.map(v => `  - ${text(v).replaceAll("\n","\n    ")}`)];
    return [`- ${field.label}: ${text(value).replaceAll("\n","\n  ")}`];
  }
  section(section: GraphTemplate["sections"][number], env: View) {
    const rows = section.rows === undefined ? [null] : list(this.evaluate(section.rows,env));
    return rows.flatMap(item => {
      const scope = {...env,item}, title = text(this.evaluate(section.heading,scope));
      if (!title) return [];
      const lines = [`${"#".repeat(section.level)} ${heading(title)}`,"",...section.fields.flatMap(field => this.field(field,scope))];
      if (section.content !== undefined) {
        const content = text(this.evaluate(section.content,scope));
        if (content) lines.push("",content);
      }
      return [lines.join("\n").trimEnd()];
    });
  }
  template(template: {record?:EntityRecord;definition:GraphTemplate}) {
    if (template.record) this.note(template.record);
    const env: View = {params:this.input.parameters};
    for (const [name,expr] of Object.entries(template.definition.bindings)) env[name] = this.evaluate(expr,env);
    if (!template.definition.require.every(requirement => this.evaluate(requirement,env)))
      throw new Response("Graph template roots are missing or mismatched",{status:409});
    return template.definition.sections.flatMap(section => this.section(section,env));
  }
}
/** Render stored templates over an already authorized graph. No IO, model,
 * domain rules, or arbitrary code. Templates cannot retrieve additional records. */
export function renderGraphTemplates(input: GraphInput) {
  if (input.templates.length < 1 || input.templates.length > 8 || input.nodes.length > 256 || input.edges.length > 4000)
    throw new Response("Graph template bounds exceeded",{status:413});
  const evaluation = new Evaluation(input);
  const templates = input.templates.map(item => ({...item,definition:graphTemplateSchema.parse(item.definition)}))
    .sort((a,b) => a.definition.order - b.definition.order || compare(a.record ? graphReference(a.record.ref) : "",b.record ? graphReference(b.record.ref) : ""));
  const markdown = `${templates.flatMap(template => evaluation.template(template)).join("\n\n")}\n`;
  // Fail explicitly rather than silently cutting authored text or required evidence.
  if (bytes(markdown) > Math.min(input.maxBytes ?? graphMarkdownBytes,graphMarkdownBytes))
    throw new Response("Graph template document exceeds 48 KiB; narrow its fields or lens",{status:413});
  return {rendererVersion:graphMarkdownVersion,mediaType:"text/markdown" as const,markdown,
    sources:[...evaluation.sources.values()].map(record => ({ref:record.ref,revision:record.revision})).sort((a,b) => compare(graphReference(a.ref),graphReference(b.ref))),
    complete:!evaluation.unresolved.size,unresolved:[...evaluation.unresolved.values()].sort((a,b) => compare(graphReference(a),graphReference(b))),omitted:[] as EntityRef[]};
}

/** Wiki's flattener: select a knowledge graph and render it through templates
 * in one authorized read. Apps pass their own versioned templates; the result
 * is factual Markdown with the exact sources it used. */
export const knowledgeGraphRenderAction = "knowledge-graph.render";
export const knowledgeGraphRenderInput = z.strictObject({
  ...knowledgeGraphSelectFields,
  templates: z.array(graphTemplateSchema).min(1).max(8),
  /** Available to templates as `$params`; `rootId` and `rootIds` are always set. */
  parameters: z.record(key, z.json()).default({}),
}).refine(oneDefinition, { message: oneDefinitionMessage });
export type KnowledgeGraphRenderInput = z.input<typeof knowledgeGraphRenderInput>;
export const renderedGraphDocument = z.strictObject({
  rendererVersion: z.literal(graphMarkdownVersion),
  mediaType: z.literal("text/markdown"),
  markdown: z.string(),
  sources: z.array(z.strictObject({ ref: entityRef, revision: z.number().int().positive() })),
  complete: z.boolean(),
  unresolved: z.array(entityRef),
  omitted: z.array(entityRef),
});
export const knowledgeGraphRenderResult = z.strictObject({ selection: knowledgeGraphSelectResult, document: renderedGraphDocument });
export type KnowledgeGraphRenderResult = z.infer<typeof knowledgeGraphRenderResult>;

/** Call Wiki's flattener through the request-scoped host (`actions.invoke`). */
export async function renderKnowledgeGraph(host: WorkflowHost<"interactive">, wikiInstallationId: string, input: KnowledgeGraphRenderInput) {
  return knowledgeGraphRenderResult.parse(await host.call("actions.call", { installationId: wikiInstallationId, action: knowledgeGraphRenderAction, input: knowledgeGraphRenderInput.parse(input), readOnly: true, maxResponseBytes: 8 * 1024 * 1024 }));
}
