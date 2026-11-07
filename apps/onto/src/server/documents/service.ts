import type { AgentDatabase, AgentStatement } from "@ai-outfitter/app-sdk/agent-store";

export type Scope = { owner: string };
export type ProviderBinding = { provider: string; config: string };
export type DocumentSection = { title: string; provider: string; pointer: string; required: boolean };
export type DocumentContract = { version: 1; identity: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; params: Record<string, unknown>; period?: {start:string;end:string}; measures?: string[]; rendering: {mode:"template"|"agent"|"combined"; template:"evidence"|"business-review"|"roadmap"|"feature-issue"|"bug-issue"; title?: string; sections?: DocumentSection[]}; refresh:"live"|"manual"|"schedule"; requirements:{evidence:boolean;seal:boolean;export:boolean} };
export type Definition = { retention?: "owner-retained"; sources: ProviderBinding[]; policy?: ProviderBinding & { required: boolean }; eventConsumer?: ProviderBinding; contract?: DocumentContract; metadata?: { identity: string; schema: string; renderer: string; refresh: string; provenance: string } };
export type Capture = { complete: boolean; errors: string[]; sources: { provider: string; config: string; provenance: unknown; snapshot: unknown; observedAt?: string }[] };
export type PolicyBinding = { owner: string; documentId: string; revision: number; digest: string; action: string; provider: string; config: string };
export type PolicyResult = { binding: PolicyBinding; decision: "allow" | "deny" | "require-review" | "unavailable"; detail?: unknown };
export type Host = {
  read(binding: ProviderBinding): Promise<{ provenance: unknown; snapshot: unknown; complete: boolean; errors?: string[] }>;
  verifyCapture(capture: Capture): Promise<boolean>;
  policy(binding: PolicyBinding): Promise<PolicyResult>;
  deliver(event: { id: string; binding: PolicyBinding }): Promise<unknown>;
};
const canonical = (v: unknown): string => JSON.stringify(v, (_k, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const digest = async (v: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(v))))).map(x => x.toString(16).padStart(2, "0")).join("");
const statement = (sql: string, ...params: unknown[]): AgentStatement => ({sql, params});
const one = async (db: AgentDatabase, sql: string, ...params: unknown[]) => (await db.query(statement(sql, ...params)))[0];
const fail = (message: string): never => { throw new Error(message); };
const guard = (sql: string, ...params: unknown[]) => statement(`INSERT INTO document_guards(id,ok) VALUES (?, CASE WHEN (${sql}) THEN 1 ELSE 0 END)`, crypto.randomUUID(), ...params);
const cleanup = statement("DELETE FROM document_guards");
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

/** Caller must derive owner and authorize definition changes from the authenticated host identity. */
export async function putDefinition(db: AgentDatabase, scope: Scope, id: string, version: number, definition: Definition) {
  if (!id || !Number.isSafeInteger(version) || version < 1 || !definition.sources.length || definition.sources.some(s => !s.provider || !s.config) || (definition.policy && (!definition.policy.provider || !definition.policy.config))) fail("Invalid definition");
  await db.batch([statement("INSERT INTO document_definitions VALUES (?,?,?,?)", scope.owner, id, version, canonical({retention:"owner-retained",...definition}))]);
}
export async function createDocument(db: AgentDatabase, scope: Scope, id: string, definitionId: string, version: number) {
  await db.batch([guard("EXISTS(SELECT 1 FROM document_definitions WHERE owner=? AND id=? AND version=?)", scope.owner, definitionId, version), statement("INSERT INTO document_heads(owner,id,definition_id,definition_version) VALUES(?,?,?,?)", scope.owner,id,definitionId,version),cleanup]);
}
async function head(db: AgentDatabase, scope: Scope, id: string) {
  return await one(db,"SELECT * FROM document_heads WHERE owner=? AND id=?",scope.owner,id) ?? fail("Document unavailable");
}
async function definition(db: AgentDatabase, scope: Scope, h: Record<string, unknown>) {
  const row = await one(db,"SELECT definition FROM document_definitions WHERE owner=? AND id=? AND version=?",scope.owner,h.definition_id,h.definition_version);
  return row ? parse<Definition>(row.definition) : fail("Definition unavailable");
}
/** Live reads are never persisted as generated revisions. */
export async function readLive(db: AgentDatabase, scope: Scope, id: string, host: Host): Promise<Capture> {
  const def = await definition(db,scope,await head(db,scope,id));
  const sources: Capture["sources"] = [], errors: string[] = [];
  for (const binding of def.sources) {
    try { const result = await host.read(binding); sources.push({...binding,provenance:result.provenance,snapshot:result.snapshot,observedAt:new Date().toISOString()}); if (!result.complete) errors.push(...(result.errors?.length ? result.errors : [`${binding.provider}: incomplete`])); }
    catch { errors.push(`${binding.provider}: unavailable`); }
  }
  return {complete:errors.length === 0 && sources.length === def.sources.length,errors,sources};
}
export async function enqueue(db: AgentDatabase, scope: Scope, documentId: string, jobId: string) {
  const prior = await one(db,"SELECT document_id FROM document_jobs WHERE owner=? AND id=?",scope.owner,jobId);
  if (prior) { if (prior.document_id !== documentId) fail("Job id conflict"); return; }
  const h = await head(db,scope,documentId);
  await db.batch([guard("EXISTS(SELECT 1 FROM document_heads WHERE owner=? AND id=? AND revision=? AND definition_version=?)",scope.owner,documentId,h.revision,h.definition_version), statement("INSERT INTO document_jobs(owner,id,document_id,definition_version,base_revision,state) VALUES(?,?,?,?,?,'queued')",scope.owner,jobId,documentId,h.definition_version,h.revision),statement("UPDATE document_heads SET latest_job=? WHERE owner=? AND id=?",jobId,scope.owner,documentId),cleanup]);
}
export async function lease(db: AgentDatabase, scope: Scope, jobId: string, token: string, now: number, duration: number) {
  if (!token || duration <= 0) fail("Invalid lease");
  await db.batch([guard("EXISTS(SELECT 1 FROM document_jobs WHERE owner=? AND id=? AND (state IN ('queued','retry') OR (state='leased' AND lease_until<=?)))",scope.owner,jobId,now),statement("UPDATE document_jobs SET state='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE owner=? AND id=?",token,now+duration,scope.owner,jobId),cleanup]);
}
export async function retry(db: AgentDatabase, scope: Scope, jobId: string, token: string, now: number, error: string) {
  await db.batch([guard("EXISTS(SELECT 1 FROM document_jobs WHERE owner=? AND id=? AND state='leased' AND lease_token=? AND lease_until>?)",scope.owner,jobId,token,now),statement("UPDATE document_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,error=?,lease_token=NULL,lease_until=NULL WHERE owner=? AND id=?",error,scope.owner,jobId),cleanup]);
}
/** Capture and generation happen outside the transaction; commit checks lease, head and supersession atomically. */
export async function complete(db: AgentDatabase, scope: Scope, jobId: string, token: string, now: number, payload: unknown, capture: Capture) {
  const job = await one(db,"SELECT * FROM document_jobs WHERE owner=? AND id=?",scope.owner,jobId) ?? fail("Job unavailable");
  const h = await head(db,scope,String(job.document_id)); const def = await definition(db,scope,h);
  if (capture.sources.length !== def.sources.length || canonical(capture.sources.map(({provider,config})=>({provider,config}))) !== canonical(def.sources)) fail("Capture bindings differ");
  const completeCapture = capture.complete && capture.errors.length === 0;
  const revision = Number(job.base_revision)+1; const hash = await digest({payload,capture,definitionId:h.definition_id,definitionVersion:job.definition_version,revision});
  await db.batch([guard("EXISTS(SELECT 1 FROM document_jobs j JOIN document_heads h ON h.owner=j.owner AND h.id=j.document_id WHERE j.owner=? AND j.id=? AND j.state='leased' AND j.lease_token=? AND j.lease_until>? AND h.latest_job=j.id AND h.revision=j.base_revision AND h.definition_version=j.definition_version)",scope.owner,jobId,token,now),statement("INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?,?,?)",scope.owner,job.document_id,revision,h.definition_id,job.definition_version,hash,canonical(payload),canonical(capture),completeCapture?1:0),statement("UPDATE document_heads SET revision=? WHERE owner=? AND id=?",revision,scope.owner,job.document_id),statement("UPDATE document_jobs SET state='complete',lease_token=NULL,lease_until=NULL WHERE owner=? AND id=?",scope.owner,jobId),cleanup]);
  return {revision,digest:hash,complete:completeCapture};
}
export async function getRevision(db: AgentDatabase, scope: Scope, id: string, revision: number) {
  const row = await one(db,"SELECT * FROM document_revisions WHERE owner=? AND document_id=? AND revision=?",scope.owner,id,revision) ?? fail("Revision unavailable");
  return {revision,digest:String(row.digest),payload:parse<unknown>(row.payload),capture:parse<Capture>(row.capture),complete:row.complete === 1,definitionId:String(row.definition_id),definitionVersion:Number(row.definition_version)};
}
export async function getJob(db: AgentDatabase, scope: Scope, id: string) {
  const row = await one(db,"SELECT j.id,j.document_id,j.state,j.attempts,j.error,j.base_revision,h.latest_job FROM document_jobs j JOIN document_heads h ON h.owner=j.owner AND h.id=j.document_id WHERE j.owner=? AND j.id=?",scope.owner,id) ?? fail("Job unavailable");
  return {id:String(row.id),documentId:String(row.document_id),state:row.latest_job !== row.id && row.state !== "complete" ? "superseded" : String(row.state),attempts:Number(row.attempts),error:row.error ? String(row.error) : null,baseRevision:Number(row.base_revision)};
}
export async function requeueJob(db: AgentDatabase, scope: Scope, id: string) {
  await db.batch([guard("EXISTS(SELECT 1 FROM document_jobs j JOIN document_heads h ON h.owner=j.owner AND h.id=j.document_id WHERE j.owner=? AND j.id=? AND j.state='failed' AND h.latest_job=j.id AND h.revision=j.base_revision)",scope.owner,id),statement("UPDATE document_jobs SET state='queued',attempts=0,error=NULL WHERE owner=? AND id=?",scope.owner,id),cleanup]);
}
export async function getDocumentDefinition(db: AgentDatabase, scope: Scope, id: string) {
  const h = await head(db,scope,id); return {id:String(h.definition_id),version:Number(h.definition_version),definition:await definition(db,scope,h)};
}
/** Exporters call this immediately before writes, in addition to policy and capture checks. */
export async function requireExportReadiness(db: AgentDatabase, scope: Scope, id: string, revision: number) {
  const r=await getRevision(db,scope,id,revision);
  const row=await one(db,"SELECT definition FROM document_definitions WHERE owner=? AND id=? AND version=?",scope.owner,r.definitionId,r.definitionVersion) ?? fail("Definition unavailable");
  const requirements=parse<Definition>(row.definition).contract?.requirements;
  if (requirements?.seal) {
    const seal=await one(db,"SELECT digest FROM document_seals WHERE owner=? AND document_id=? AND revision=?",scope.owner,id,revision);
    if (seal?.digest!==r.digest) fail("Sealed revision required for export");
  }
  return {definitionId:r.definitionId,definitionVersion:r.definitionVersion,requirements:requirements ?? null};
}
/** Sealing records integrity only; it neither requests nor grants approval. */
export async function seal(db: AgentDatabase, scope: Scope, id: string, revision: number, expectedDigest: string, host: Host, now: number) {
  const r = await getRevision(db,scope,id,revision);
  if (!r.complete || r.digest !== expectedDigest || !(await host.verifyCapture(r.capture))) fail("Capture incomplete or stale");
  const defRow = await one(db,"SELECT definition FROM document_definitions WHERE owner=? AND id=? AND version=?",scope.owner,r.definitionId,r.definitionVersion) ?? fail("Definition unavailable");
  const def = parse<Definition>(defRow.definition);
  if (def.policy?.required) {
    const decision = await evaluatePolicy(db,scope,id,revision,"seal",host);
    if (decision.decision !== "allow") fail("Required policy did not allow sealing");
  }
  const event: PolicyBinding | undefined = def.eventConsumer && {owner:scope.owner,documentId:id,revision,digest:expectedDigest,action:"document.sealed",provider:def.eventConsumer.provider,config:def.eventConsumer.config};
  const eventId = event ? `sealed:${await digest(event)}` : undefined;
  await db.batch([guard("EXISTS(SELECT 1 FROM document_heads h JOIN document_revisions r ON r.owner=h.owner AND r.document_id=h.id AND r.revision=h.revision JOIN document_definitions d ON d.owner=r.owner AND d.id=r.definition_id AND d.version=r.definition_version WHERE h.owner=? AND h.id=? AND h.revision=? AND h.definition_id=r.definition_id AND h.definition_version=r.definition_version AND r.digest=? AND r.complete=1 AND d.definition=?)",scope.owner,id,revision,expectedDigest,defRow.definition),statement("INSERT INTO document_seals VALUES(?,?,?,?,?) ON CONFLICT(owner,document_id,revision) DO NOTHING",scope.owner,id,revision,expectedDigest,now),...(event ? [statement("INSERT INTO document_events(owner,id,binding,state) VALUES(?,?,?,'pending') ON CONFLICT(owner,id) DO NOTHING",scope.owner,eventId,canonical(event))] : []),cleanup]);
  return {sealed:true,revision,digest:expectedDigest,approval:"not_requested" as const};
}
export async function evaluatePolicy(db: AgentDatabase, scope: Scope, id: string, revision: number, action: string, host: Host) {
  const h = await head(db,scope,id); const r = await getRevision(db,scope,id,revision);
  if (Number(h.revision)!==revision) fail("Stale revision");
  if (!r.complete) return {decision:"unavailable" as const};
  const row = await one(db,"SELECT definition FROM document_definitions WHERE owner=? AND id=? AND version=?",scope.owner,r.definitionId,r.definitionVersion) ?? fail("Definition unavailable");
  const policy = parse<Definition>(row.definition).policy;
  if (!policy) return {decision:"allow" as const,detail:{reason:"no_policy_configured"}};
  const binding: PolicyBinding = {owner:scope.owner,documentId:id,revision,digest:r.digest,action,provider:policy.provider,config:policy.config};
  let result: PolicyResult;
  try { result = await host.policy(binding); } catch { return {decision:"unavailable" as const,binding}; }
  if (Number((await head(db,scope,id)).revision) !== revision) return {decision:"unavailable" as const,binding};
  if (canonical(result.binding)!==canonical(binding) || !["allow","deny","require-review","unavailable"].includes(result.decision)) return {decision:"unavailable" as const,binding};
  return result;
}
/** Delivery is host-owned and at-least-once; host must deduplicate by event id. */
export async function deliverEvents(db: AgentDatabase, scope: Scope, host: Host, now: number, limit = 10) {
  if (!Number.isInteger(limit) || limit<1 || limit>10) fail("Invalid event limit");
  await db.batch([statement("UPDATE document_events SET state='failed',error='Delivery lease expired after maximum attempts',lease_token=NULL,lease_until=NULL WHERE owner=? AND state='leased' AND lease_until<=? AND attempts>=5",scope.owner,now)]);
  const rows=await db.query(statement("SELECT id,binding FROM document_events WHERE owner=? AND attempts<5 AND (state IN ('pending','retry') OR (state='leased' AND lease_until<=?)) ORDER BY rowid LIMIT ?",scope.owner,now,limit));
  let delivered=0, failed=0;
  for (const row of rows) {
    const leaseNow=Date.now();
    const eventId=String(row.id), encoded=String(row.binding), binding=parse<PolicyBinding>(encoded), token=crypto.randomUUID();
    try { await db.batch([guard("EXISTS(SELECT 1 FROM document_events WHERE owner=? AND id=? AND binding=? AND attempts<5 AND (state IN ('pending','retry') OR (state='leased' AND lease_until<=?)))",scope.owner,eventId,encoded,leaseNow),statement("UPDATE document_events SET state='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE owner=? AND id=?",token,leaseNow+120_000,scope.owner,eventId),cleanup]); } catch { continue; }
    try {
      const revision=await getRevision(db,scope,binding.documentId,binding.revision);
      const defRow=await one(db,"SELECT definition FROM document_definitions WHERE owner=? AND id=? AND version=?",scope.owner,revision.definitionId,revision.definitionVersion) ?? fail("Definition unavailable");
      const consumer=parse<Definition>(defRow.definition).eventConsumer;
      const sealed=await one(db,"SELECT digest FROM document_seals WHERE owner=? AND document_id=? AND revision=?",scope.owner,binding.documentId,binding.revision);
      if (binding.owner!==scope.owner || binding.action!=="document.sealed" || revision.digest!==binding.digest || sealed?.digest!==binding.digest || consumer?.provider!==binding.provider || consumer.config!==binding.config) fail("Invalid sealed event");
      const active=await one(db,"SELECT id FROM document_events WHERE owner=? AND id=? AND state='leased' AND lease_token=? AND lease_until>?",scope.owner,eventId,token,Date.now());
      if (!active) fail("Event lease expired before dispatch");
      const result=await host.deliver({id:eventId,binding});
      await db.batch([guard("EXISTS(SELECT 1 FROM document_events WHERE owner=? AND id=? AND state='leased' AND lease_token=? AND lease_until>?)",scope.owner,eventId,token,Date.now()),statement("UPDATE document_events SET state='delivered',result=?,lease_token=NULL,lease_until=NULL WHERE owner=? AND id=?",canonical(result),scope.owner,eventId),cleanup]); delivered++;
    } catch (error) {
      failed++; await db.batch([statement("UPDATE document_events SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,error=?,lease_token=NULL,lease_until=NULL WHERE owner=? AND id=? AND state='leased' AND lease_token=? AND lease_until>?",String(error).slice(0,500),scope.owner,eventId,token,Date.now())]);
    }
  }
  return {delivered,failed};
}
