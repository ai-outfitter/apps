import assert from "node:assert/strict";
import test from "node:test";
import { briefMarkdown, dailyBriefSchedule, setDailyBriefSchedule } from "../src/server/daily-brief";
import type { DayReview } from "../src/server/day-review";
const who = { owner: { kind: "user", id: "alice" }, userId: "alice", installationId: "f", canEdit: true, role: "owner" } as const;
test("schedule reads never enable it; explicit saves preserve enabled=false and timezone", async () => {
  const calls: unknown[] = [];
  const host = { call: async (op: string, input: unknown) => { calls.push([op,input]); return op === 'schedules' ? [] : input; } } as never;
  assert.equal(await dailyBriefSchedule(host, who), null);
  await setDailyBriefSchedule(host, who, { enabled: false, timezone: 'America/Chicago' });
  assert.deepEqual(calls, [['schedules',{}],['schedule.save',{workflow:'forerunner-daily-brief',cron:'0 5 * * *',enabled:false,timezone:'America/Chicago',inputs:{}}]]);
  await assert.rejects(() => setDailyBriefSchedule(host, { ...who, owner: { kind: 'organization', id: 'org' } }, { enabled: true, timezone: 'America/Chicago' }), /./);
  await assert.rejects(() => setDailyBriefSchedule(host, who, { enabled: true, timezone: 'invalid/zone' }));
});
test("brief pins prior context and source revisions, preserves missing reports and unknown measurements", () => {
  const review = { period: { date:'2026-11-10', timezone:'America/Chicago' }, organizations:[{name:'Example',summary:'Source missing',status:'missing',href:null,projects:[]}], overview:null, completions:[],warnings:['Source discovery incomplete'] } as unknown as DayReview;
  const body = briefMarkdown('2026-11-11',review,[{title:'Choose testers',category:'stone'}],{slug:'prior',revision:3});
  assert.match(body,/prior\?revision=3/); assert.match(body,/Choose testers/); assert.match(body,/Coverage: missing/); assert.match(body,/Stripe: not collected/); assert.match(body,/Source discovery incomplete/);
  assert.doesNotMatch(body,/0 orders|paid orders observed/);
});

test("capture writes one owner-scoped Wiki document, reuses unchanged content, and refuses archived documents", async context => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const { migrate } = await import('drizzle-orm/libsql/migrator');
  const { fileURLToPath } = await import('node:url');
  const { captureDailyBrief, scheduledDailyBrief } = await import('../src/server/daily-brief');
  const client = createClient({ url: ':memory:' }); const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  const stored = new Map<string, {id:string;revision:number;generatedBody:string;archived:boolean}>();
  let writes=0; const workflowCalls: string[]=[];
  context.mock.method(Date,'now',()=>Date.parse('2026-11-11T15:00:00Z'));
  const host = { call: async (op:string, args:any) => {
    if(op==='schedules') return [{id:'schedule',timezone:'America/Chicago'}];
    if(op==='workflow.start' || op==='workflow.collect'){ workflowCalls.push(op); if(op==='workflow.collect')assert.equal(args.complete,true);return {}; }
    if(op==='actions.list') return [{ installationId:'personal-wiki', actions:[{name:'graph.describe',access:'read',permitted:true}] }];
    if(op==='actions.call' && args.installationId==='personal-wiki') {
      if(args.action==='graph.describe') return {version:1,contracts:[{id:'outfitter.wiki-documents',version:1}],capabilities:['documents'],types:[],queryAction:'graph.graphql'};
      const { query, variables } = args.input;
      if(query.includes('BriefPage')) return {data:{page:stored.has(variables.slug)?{documentId:stored.get(variables.slug)!.id}:null}};
      if(query.includes('BriefDraft')) return {data:{document:[...stored.values()].find(d=>d.id===variables.id)}};
      if(query.includes('SaveGeneratedDocument')) { writes++; const w=variables.input;assert.equal(w.provenance.owner.id,'alice'); const value={id:'doc',revision:writes,generatedBody:w.generatedBody,archived:false};stored.set(w.slug,value);return {data:{saveGeneratedDocument:{id:value.id,revision:value.revision}}}; }
    }
    throw new Response('Source unavailable',{status:503});
  } } as never;
  try {
    const input={date:'2026-11-11',timezone:'America/Chicago',runId:'run'};
    const now=Date.parse('2026-11-11T15:00:00Z');
    const first=await captureDailyBrief(db as never,who,host,input,now);
    const second=await captureDailyBrief(db as never,who,host,{...input,runId:'retry'},now);
    assert.equal(first.status,'incomplete');assert.deepEqual(first,second);assert.equal(writes,1);
    await scheduledDailyBrief(db as never,who,{runId:crypto.randomUUID(),scheduledFor:now,schedule:{id:'schedule',workflowId:'forerunner-daily-brief',inputs:{},connectionId:null,resource:null}},host);
    assert.deepEqual(workflowCalls,['workflow.start','workflow.collect']);assert.equal(writes,1);
    stored.get(first.slug)!.archived=true;
    await assert.rejects(()=>captureDailyBrief(db as never,who,host,input,now),e=>e instanceof Response && e.status===409);
    assert.equal(writes,1);
  } finally {client.close();}
});
