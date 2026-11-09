/** App-owned batch documents over existing, independently authorized mutations. */
import { sql } from "drizzle-orm";
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, execute, type DocumentNode, type GraphQLField, getOperationAST, getNamedType, isObjectType, isScalarType, isEnumType, parse, print, visit } from "graphql";
import { z } from "zod";
import { mutationField } from "./app-graphql";
import { JSONScalar } from "./graph-graphql";
import { canonicalActionValue } from "./actions";
import type { AppDocument } from "./app-documents";

export type Instruction = { code: string; itemKey: string; actor: "caller" | "agent" | "human" | "system"; required: boolean; message: string; call?: unknown; taskId?: string; url?: string };
export type ChangeReceipt = { key: string; status: "complete" | "pending" | "failed" | "uncertain"; result?: unknown; error?: { code: string; message: string } };
export type BatchResult = { items: ChangeReceipt[]; instructions: Instruction[] };
export type BatchGroups = Record<string, { description: string; actions: Record<string, string>; resultFields?: string[]; documents?: Record<string, DocumentNode>; replayResult?: boolean; authorizeReplay?: (context: any) => Promise<boolean> }>;
const text = { type: new GraphQLNonNull(GraphQLString) };
export const instructionType = new GraphQLObjectType({ name: "ChangeInstruction", fields: {
  code: text, itemKey: text, actor: text, required: { type: new GraphQLNonNull(GraphQLBoolean) }, message: text,
  call: { type: JSONScalar }, taskId: { type: GraphQLString }, url: { type: GraphQLString },
} });
const receiptType = new GraphQLObjectType({ name: "ChangeReceipt", fields: {
  key: text, status: text, result: { type: JSONScalar }, error: { type: JSONScalar },
} });
export const batchResultType = new GraphQLObjectType({ name: "ChangeResults", fields: {
  items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(receiptType))) },
  instructions: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(instructionType))) },
} });

/** Status guidance is emitted only for actual unfinished domain work. */
export function resultInstructions(key: string, value: unknown): Instruction[] {
  if (!value || typeof value !== "object") return [];
  const result = value as Record<string, any>;
  const instructions: Instruction[] = Array.isArray(result.instructions) ? result.instructions.map((instruction:Instruction)=>({...instruction,itemKey:key})) : [];
  if((result.preview === true || result.phase === "preview") && result.previewToken)instructions.push({code:"CONFIRM_INSTALL",itemKey:key,actor:"caller",required:true,message:"Review the installation preview, then confirm its previewToken using a new request key."});
  if (result.state === "open") instructions.push({ code: "SUBMIT_CHANGES", itemKey: key, actor: "caller", required: true, message: "Append remaining changes, then submit the batch." });
  if ((result.state === "awaiting_review" || result.status === "awaiting_review") && !instructions.length) instructions.push({ code: "AWAIT_REVIEW", itemKey: key, actor: "human", required: true, message: "Wait for an authorized reviewer; submission does not grant approval." });
  instructions.push(...workInstructions(key, result));
  return instructions;
}

function workInstructions(key: string, result: Record<string, any>): Instruction[] {
  const instructions: Instruction[] = [];
  for (const waiting of result.openWork?.awaiting ?? []) instructions.push({ code: `GOVERNANCE_${String(waiting.step).toUpperCase()}`, itemKey: key,
    actor: waiting.kind === "Agent" ? "agent" : "human", required: waiting.required !== false, message: `${waiting.holder}: ${waiting.step}${waiting.blockedBy ? ` (${waiting.blockedBy})` : ""}.` });
  const run = result.run;
  if (run?.id && !["complete", "completed", "failed", "cancelled"].includes(run.status)) instructions.push({ code: "WAIT_FOR_RUN", itemKey: key, actor: "system", required: true, message: "Read the retained run before retrying.", taskId: run.id });
  return instructions;
}

/** All app migrations install this table. A claimed but unrecorded result is uncertain, never automatically replayed. */
export async function retainedChange(context: any, document: string, key: string, input: unknown, run: () => Promise<unknown>, options: { replayResult?: boolean; authorizeReplay?: () => Promise<boolean> } = {}): Promise<{ receipt: ChangeReceipt; instructions: Instruction[] }> {
  const db = context.db();
  const actor = canonicalActionValue({ user: context.identity.userId, actor: actorIdentity(context.actor), origin: actorIdentity(context.originActor) });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalActionValue(input)));
  const fingerprint = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  const nonce = crypto.randomUUID();
  await db.run(sql`INSERT INTO graph_change_receipts (actor, document, request_key, fingerprint, claim, created_at) VALUES (${actor}, ${document}, ${key}, ${fingerprint}, ${nonce}, ${Date.now()}) ON CONFLICT DO NOTHING`);
  const [row] = await db.all(sql`SELECT fingerprint, claim, result FROM graph_change_receipts WHERE actor = ${actor} AND document = ${document} AND request_key = ${key}`);
  if (row.fingerprint !== fingerprint) return { receipt: { key, status: "failed", error: { code: "IDEMPOTENCY_CONFLICT", message: "This key already identifies different input." } }, instructions: [] };
  if (row.result && await mayReplayResult(options)) return JSON.parse(row.result);
  if (row.result) return { receipt: { key, status: "uncertain" }, instructions: [{ code: "READ_BEFORE_RETRY", itemKey: key, actor: "caller", required: true, message: "Read current records using your current access; this key will not repeat the change." }] };
  if (row.claim !== nonce) return { receipt: { key, status: "uncertain" }, instructions: [{ code: "READ_BEFORE_RETRY", itemKey: key, actor: "caller", required: true, message: "The request is running or its response was lost. Read the affected records before retrying; this key will not repeat writes." }] };
  let answer: { receipt: ChangeReceipt; instructions: Instruction[] };
  try {
    const result = await run();
    const instructions = resultInstructions(key, result);
    answer = { receipt: { key, status: instructions.some(item => item.required) ? "pending" : "complete", result }, instructions };
  } catch (error) {
    // A refused operation can have saved earlier cross-service work. Do not silently retry it.
    const known = error instanceof Response || (error instanceof Error && "extensions" in error && ["REFUSED", "BAD_USER_INPUT"].includes(String((error.extensions as {code?: unknown})?.code)));
    const message = error instanceof Response ? await error.text() : known && error instanceof Error ? error.message : "Execution failed; read retained records before retrying.";
    answer = { receipt: { key, status: "uncertain", error: { code: "EXECUTION_UNCERTAIN", message: message.slice(0, 1000) } }, instructions: [{ code: "READ_BEFORE_RETRY", itemKey: key, actor: "caller", required: true, message: "Check retained records before starting another request." }] };
  }
  await db.run(sql`UPDATE graph_change_receipts SET result = ${JSON.stringify(answer)} WHERE actor = ${actor} AND document = ${document} AND request_key = ${key} AND claim = ${nonce}`);
  return answer;
}

function actorIdentity(actor: {kind: string; id: string} | undefined) {
  return actor && {kind: actor.kind, id: actor.id};
}

async function mayReplayResult(options: { replayResult?: boolean; authorizeReplay?: () => Promise<boolean> }) {
  return options.replayResult !== false || await options.authorizeReplay?.().catch(() => false);
}

/** A caller-chosen idempotency key, unique per caller and document: any short name, such as
 * "add-ada" or "stage-1". Retrying the same key with the same input replays its receipt. */
export const changeKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "Use letters, digits, '.', '_', ':' or '-', at most 128").describe("Your stable key for this item: any short name, such as add-ada. Reuse it only to retry the same input.");

function inputsFor(schema: GraphQLSchema, group: BatchGroups[string]) {
  const fields = schema.getMutationType()?.getFields() ?? {};
  return z.array(z.discriminatedUnion("action", Object.entries(group.actions).map(([action, field]) => {
    const input = fields[field]?.extensions.batchInput as z.ZodType | undefined;
    if (!input) throw new Error(`Batch action ${field} must use mutationField`);
    return z.strictObject({ key: changeKey, action: z.literal(action), input });
  }) as any)).min(1).max(20).superRefine((items, ctx) => {
    if (new Set(items.map(item => item.key)).size !== items.length) ctx.addIssue({ code: "custom", message: "Each item must have a distinct key." });
  });
}

/** Adds collection mutations without replacing existing app resolvers or their authorization. */
export function batchSchema(schema: GraphQLSchema, groups: BatchGroups): GraphQLSchema {
  const original = schema.getMutationType();
  if (!original) throw new Error("Batch documents require mutations");
  const fields = original.toConfig().fields;
  const additions = Object.fromEntries(Object.entries(groups).map(([name, group]) => {
    const describedInput = z.strictObject({ items: inputsFor(schema, group) });
    const input = z.strictObject({items:z.array(z.strictObject({key:changeKey,action:z.enum(Object.keys(group.actions) as [string,...string[]]),input:z.unknown()})).min(1).max(20)}).superRefine((value,ctx)=>{
      if(new Set(value.items.map(item=>item.key)).size!==value.items.length)ctx.addIssue({code:"custom",message:"Each item needs a distinct key."});
    });
    const definition=mutationField({ name, description: group.description, input, output: batchResultType,
      run: async (context: any, { items }: z.output<typeof input>) => {
        const result: BatchResult = { items: [], instructions: [] };
        for (const item of items) {
          const field = fields[group.actions[item.action]];
          const validator = field.extensions?.batchInput as z.ZodType | undefined;
          if (!validator) throw new Error("Batch action is missing its input validator");
          const valid=validator.safeParse(item.input);
          if(!valid.success){result.items.push({key:item.key,status:"failed",error:{code:"INVALID_INPUT",message:valid.error.issues.map(issue=>`${issue.path.join(".")}: ${issue.message}`).join("; ")}});continue;}
          const saved = await retainedChange(context, name, item.key, item, async () => {
            return executeBatchItem(schema, group, field, item, context);
          }, { replayResult: group.replayResult, authorizeReplay: group.authorizeReplay ? () => group.authorizeReplay!(context) : undefined });
          result.items.push(saved.receipt); result.instructions.push(...saved.instructions);
        }
        return result;
      },
    });
    definition.extensions={...definition.extensions,batchInput:describedInput};
    return [name[0].toLowerCase() + name.slice(1),definition];
  }));
  return new GraphQLSchema({ ...schema.toConfig(), types: schema.toConfig().types.filter(type => type !== original), mutation: new GraphQLObjectType({ ...original.toConfig(), fields: { ...fields, ...additions } }) });
}

async function executeBatchItem(schema: GraphQLSchema, group: BatchGroups[string], field: any, item: {action:string;input:unknown}, context: any) {
            let value: any;
            const fieldName = group.actions[item.action];
            const document = group.documents?.[fieldName] ?? batchItemDocument(fieldName, field);
            {
              const response = await execute({schema,document,variableValues:{input:item.input},contextValue:context});
              if(response.errors?.length)throw response.errors[0];
              value=Object.values(response.data ?? {})[0];
            }
            return group.resultFields && value && typeof value === "object" ? Object.fromEntries(group.resultFields.filter(key => key in value).map(key => [key, value[key]])) : value;
}

function batchItemDocument(fieldName: string, field: any): DocumentNode {
  const selection = outputSelection(field.type, new Set());
  if (selection === undefined) throw new Error(`Batch output for ${fieldName} has no selectable fields`);
  return parse(`mutation BatchItem($input: ${field.args.input.type}) { ${fieldName}(input: $input) ${selection} }`);
}

function outputSelection(type: any, seen: Set<string>): string | undefined {
  const named = getNamedType(type);
  if (!isObjectType(named)) return "";
  if (seen.has(named.name)) return undefined;
  const path = new Set(seen).add(named.name);
  const fields = Object.values(named.getFields()).filter(field => !field.args.some(arg => arg.type instanceof GraphQLNonNull && arg.defaultValue === undefined));
  const selected = fields.flatMap(field => {
    const child = outputSelection(field.type, path);
    return child === undefined ? [] : [`${field.name} ${child}`];
  });
  return selected.length ? `{ ${selected.join(" ")} }` : undefined;
}

/** Original documents remain executable for existing pages but disappear from discovery. */
export function withBatchDocuments<T extends Record<string, AppDocument>, G extends BatchGroups>(documents: T, schema: GraphQLSchema, configured: G, collectionNames: Record<string, string> = {}): T & { [K in keyof G]: AppDocument & {document:DocumentNode} } {
  const groups:BatchGroups=configured;
  const grouped = new Set(Object.values(groups).flatMap(group => Object.values(group.actions)));
  const legacy = legacyBatchDocuments(documents, groups, grouped);
  const batches = Object.fromEntries(Object.entries(groups).map(([name, group]) => {
    const fieldName = name[0].toLowerCase() + name.slice(1);
    const field = schema.getMutationType()!.getFields()[fieldName];
    const input = field.extensions.batchInput as z.ZodType;
    return [name, { story: `As an authorized caller, I want to ${group.description.replace(/\.$/, "").replace(/^./, c => c.toLowerCase())}, so that each change has a durable receipt and explicit next steps.`,
      document: parse(`mutation ${name}($input: ${name}Input!) { ${fieldName}(input: $input) { items { key status result error } instructions { code itemKey actor required message call taskId url } } }`),
      inputSchema: { type: "object", properties: { input: z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) }, required: ["input"], additionalProperties: false },
    }];
  }));
  const collections = collectionDocuments(documents, schema, collectionNames);
  return { ...legacy, ...collections, ...batches } as T & { [K in keyof G]: AppDocument & {document:DocumentNode} };
}

function legacyBatchDocuments(documents: Record<string, AppDocument>, groups: BatchGroups, grouped: Set<string>) {
  return Object.fromEntries(Object.entries(documents).map(([name, entry]) => {
    const document = typeof entry.document === "string" ? parse(entry.document) : entry.document;
    const ast = getOperationAST(document);
    const field = ast?.selectionSet.selections[0];
    if (field?.kind === "Field" && ast?.operation === "mutation") {
      for (const group of Object.values(groups)) {
        if (Object.values(group.actions).includes(field.name.value)) {
          group.documents ??= {};
          group.documents[field.name.value] = document;
        }
      }
    }
    return [name, { ...entry, ...(field?.kind === "Field" && grouped.has(field.name.value) ? { hidden: true } : {}) }];
  }));
}

function collectionDocuments(documents: Record<string, AppDocument>, schema: GraphQLSchema, collectionNames: Record<string, string>): Record<string, AppDocument> {
  const collections: Record<string, AppDocument> = {};
  for (const entry of Object.values(documents)) if (entry.publicName) {
    const {hidden:_hidden,publicName,...shown} = entry;
    const original = typeof entry.document === "string" ? parse(entry.document) : entry.document;
    let source = print(visit(original,{OperationDefinition:node=>({...node,name:{kind:"Name",value:publicName}})}));
    if (publicName === "WorkItems") source=source.replace("$input: OpenWorkInput!", "$input: OpenWorkInput! = {}");
    collections[publicName]={...shown,document:source};
  }
  addGeneratedCollections(collections, documents, schema, collectionNames);
  return collections;
}

function addGeneratedCollections(collections: Record<string, AppDocument>, documents: Record<string, AppDocument>, schema: GraphQLSchema, collectionNames: Record<string, string>) {
  for (const [fieldName, field] of Object.entries(schema.getQueryType()?.getFields() ?? {})) {
    const connection = getNamedType(field.type);
    if (!isObjectType(connection) || !connection.getFields().nodes || !connection.getFields().pageInfo) continue;
    const row = getNamedType(connection.getFields().nodes.type);
    if (!isObjectType(row)) continue;
    const name = collectionNames[fieldName] ?? fieldName[0].toUpperCase() + fieldName.slice(1);
    if (documents[name]) continue;
    addGeneratedCollection(collections, fieldName, name, field, row);

  }
}

function addGeneratedCollection(collections: Record<string, AppDocument>, fieldName: string, name: string, field: GraphQLField<unknown, unknown>, row: GraphQLObjectType) {
    const selected = ["id","slug","name","title","kind","status","revision","updatedAt"].filter(key => {
      const member = row.getFields()[key];
      return member && (isScalarType(getNamedType(member.type)) || isEnumType(getNamedType(member.type)));
    });
    if (!selected.length) return;
    const args = field.args.filter(arg => !/(?:installation|organization)(?:ids?|slugs?)$/i.test(arg.name));
    collections[name] = {story:`As a caller, I want to search ${fieldName} with compact results, so that I can select records and continue through every page.`,
      document:`query ${name}${args.length ? `(${args.map(arg=>`$${arg.name}: ${arg.type}${arg.name === "first" ? " = 20" : ""}`).join(", ")})` : ""} { ${fieldName}${args.length ? `(${args.map(arg=>`${arg.name}: $${arg.name}`).join(", ")})` : ""} { nodes { ${selected.join(" ")} } pageInfo { endCursor hasNextPage } } }`};
}

/** Several focused reads through one plural document; each source keeps its existing admission. */
export type ReadGroups = Record<string,{field:string;description:string;defaults?:(context:any)=>Promise<unknown[]>}>;
export function readBatchSchema(schema:GraphQLSchema,groups:ReadGroups) {
  const query=schema.getQueryType()!;
  const fields=query.toConfig().fields;
  const additions=Object.fromEntries(Object.entries(groups).map(([name,group])=>{
    const source=fields[group.field];
    const individual=source.extensions?.batchInput as z.ZodType;
    if(!individual)throw new Error(`${group.field} must use mutationField`);
    const input=z.strictObject({inputs:z.array(individual).max(100).optional(),ids:z.array(z.string()).max(100).optional(),search:z.string().max(200).optional(),first:z.number().int().min(1).max(100).default(20),after:z.string().regex(/^\d+$/).optional()});
    return [name[0].toLowerCase()+name.slice(1),mutationField({name,description:group.description,input,
      run:async(context:any,args)=>{
        const inputs=args.inputs ?? await group.defaults?.(context) ?? [];
        const selected=inputs.filter(value=>(!args.ids || args.ids.some(id=>Object.values(value as object).includes(id))) && (!args.search || JSON.stringify(value).toLowerCase().includes(args.search.toLowerCase())));
        const start=Number(args.after ?? 0);
        if(!Number.isSafeInteger(start))throw new Response("Invalid cursor",{status:400});
        return {items:await Promise.all(selected.slice(start,start+args.first).map(async(input,index)=>{
          try{return {index:start+index,result:await source.resolve!(undefined,{input:individual.parse(input)},context,undefined as never)};}
          catch(error){return {index:start+index,error:error instanceof Response ? await error.text() : "Read unavailable"};}
        })),pageInfo:{hasNextPage:start+args.first<selected.length,endCursor:start+args.first<selected.length ? String(start+args.first) : null}};
      },
    })];
  }));
  return new GraphQLSchema({...schema.toConfig(),types:schema.toConfig().types.filter(type=>type!==query),query:new GraphQLObjectType({...query.toConfig(),fields:{...fields,...additions}})});
}
export function readBatchDocuments<T extends Record<string,AppDocument>, G extends ReadGroups>(documents:T,schema:GraphQLSchema,groups:G):T & {[K in keyof G]:AppDocument & {document:DocumentNode}} {
  const hidden=new Set(Object.values(groups).map(group=>group.field));
  const rows=Object.fromEntries(Object.entries(documents).map(([name,entry])=>{
    const field=getOperationAST(typeof entry.document==="string" ? parse(entry.document):entry.document)?.selectionSet.selections[0];
    return [name,{...entry,...(field?.kind==="Field"&&hidden.has(field.name.value)?{hidden:true}:{})}];
  }));
  for(const [name,group] of Object.entries(groups)){
    const fieldName=name[0].toLowerCase()+name.slice(1);
    const field=schema.getQueryType()!.getFields()[fieldName];
    rows[name]={story:`As a caller, I want to ${group.description.toLowerCase()}, so that I can inspect several results in one read.`,document:parse(`query ${name}($input:${name}Input! = {}) { ${fieldName}(input:$input) }`),inputSchema:{type:"object",properties:{input:z.toJSONSchema(field.extensions.batchInput as z.ZodType,{io:"input",unrepresentable:"any"})}}};
  }
  return rows as T & {[K in keyof G]:AppDocument & {document:DocumentNode}};
}
