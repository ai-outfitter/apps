import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { wikiGraphFixture } from "@ai-outfitter/app-test/wiki-fixture";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
  discoveryActivity,
  discoveryRuns,
  discoverySources,
  getPreview,
  importSamples,
  previewDiscovery,
  saveDiscovery,
  sourceSample,
} from "../src/server/discovery";

const defaults = ["Person", "Organization", "Product", "Activity", "Asset", "FinancialObligation", "Goal", "Problem", "participates_in", "owns", "has_obligation", "secured_by", "interacts_with", "uses", "Question", "about"].map((name, i) => ({ id: `10000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`, name, category: i < 8 || name === "Question" ? "node" : "edge", body: name === "Person" ? "A human." : `An identifiable ${name}.` }));
const semantic = { entities: [{ key: "bob", name: "Bob", type: "Person", summary: "Named participant in the draft review.", existingId: null, certainty: "mentioned", evidence: ["e0"] }], relationships: [] };
const who: AppIdentity = {
  installationId: "forerunner",
  userId: "alice",
  owner: { kind: "user", id: "alice" },
  role: "owner",
  canEdit: true,
};
const sample = sourceSample.parse({
  format: "outfitter-forerunner-sample-v1",
  provider: "gmail",
  account: "alice@example.test",
  collectedAt: "2026-10-29T12:00:00Z",
  window: "Last 14 days; partial sample",
  collectionMethod: "agent-import",
  records: [
    {
      id: "msg-1",
      title: "<script>untrusted</script>",
      text: "Please review the draft.",
      date: "2026-10-28",
      participants: ["Bob"],
    },
  ],
});
/** The Wiki's batch actions and documents, as Forerunner sees them: a first run commits on submit. */
function wikiBatch(input: Record<string, unknown>, state: string) {
  const batch = { id: "b0000000-0000-4000-8000-000000000001", state, reviewBy: null };
  if (input.action !== "graph.mutate") return { state, body: { batch, counts: {} } };
  if ((input.input as { operationName: string }).operationName === "StageChanges") return { state, body: { data: { stageChanges: { ...batch, counts: {} } } } };
  return { state: "committed", body: { data: { submitBatch: { ...batch, state: "committed", counts: { committed: 1 }, operations: [] } } } };
}
const status = (code: number) => (e: unknown) =>
  e instanceof Response && e.status === code;
test("private sample -> persisted preview -> exact graph.apply; retries and owner isolation", async () => {
  const client = createClient({ url: ":memory:" }),
    db = drizzle(client);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  const writes: unknown[] = [];
  const host = {
    call: async (name: string, input: Record<string, unknown>) => {
      const fixed: Record<string, unknown> = {
        "identity.current": { id: "alice", name: "Alice", email: "alice@example.test" },
        snapshot: { connections: [] },
        "session.append": {}, "workflow.start": { id: "run" }, "workflow.collect": {}, "inference.generate": { output: semantic },
      };
      if (name in fixed) return fixed[name];
      if (name === "entities.types")
        return ["graph-type", "graph-node", "graph-edge"].map((type) => ({
          type,
          installationId: "wiki",
          writable: true,
        }));
      if (name === "actions.call" && input.action === "graph.read") return wikiGraphFixture("wiki", { types: defaults.map(t => ({ ref: { installationId: "wiki", type: "graph-type", id: t.id }, attributes: t })) });
      if (name === "actions.call") {
        writes.push(input);
        const reply = wikiBatch(input, batchState);
        batchState = reply.state;
        return reply.body;
      }
      throw new Error(name);
    },
  } as unknown as WorkflowHost<"interactive">;
  let batchState = "open";
  try {
    await importSamples(db, who, { samples: [sample] });
    await importSamples(db, who, { samples: [sample] });
    await assert.rejects(
      importSamples(db, who, {
        samples: [{ ...sample, window: "Changed capture" }],
      }),
      status(409),
    );
    const sources = await discoverySources(db, who, host);
    assert.equal(sources.sources.length, 1);
    const preview = await previewDiscovery(db, who, host, {
      sources: [sources.sources[0].id],
    });
    const history = await discoveryRuns(db, who) as { id: string; status: string }[];
    assert.equal(history[0].status, "complete");
    const run = await discoveryRuns(db, who, history[0].id) as Record<string, unknown>;
    assert.match(String(run.systemPrompt), /Name: Alice/);
    assert.doesNotMatch(String(run.systemPrompt), /^- (Activity|participates_in):/m);
    assert.ok(run.input && run.output && run.schema && run.workflowRunId);
    await assert.rejects(discoveryRuns(db, { ...who, userId: "other" }, history[0].id), status(404));
    assert.equal(writes.length, 0);
    assert.equal(preview.entries.length, 1);
    assert.equal(preview.entries[0].title, "Bob");
    assert.ok(preview.operations.every(op => op.type !== "graph-type"));
    assert.ok(!JSON.stringify(preview.operations).includes("DiscoveryObservation"));
    assert.equal(preview.sources[0].method, "agent-import");
    assert.equal((await getPreview(db, who))?.id, preview.id);
    const again = await previewDiscovery(db, who, host, {
      sources: [sources.sources[0].id],
    });
    assert.deepEqual(again.operations, preview.operations);
    await client.execute({ sql: "UPDATE forerunner_discovery_records SET data = ? WHERE id = ?", args: [JSON.stringify({...again, version:3}), again.id] });
    await assert.rejects(saveDiscovery(db, who, host, {previewId:again.id, confirmDestination:true}), status(409));
    assert.equal(writes.length, 0);

    const other = {
      ...who,
      userId: "bob",
      owner: { kind: "user" as const, id: "bob" },
    };
    await assert.rejects(getPreview(db, other, preview.id), status(404));
    await assert.rejects(
      saveDiscovery(db, other, host, {
        previewId: preview.id,
        confirmDestination: true,
      }),
      status(404),
    );
    await assert.rejects(
      previewDiscovery(db, { ...who, canEdit: false }, host, {
        sources: [sources.sources[0].id],
      }),
      status(403),
    );
    await saveDiscovery(db, who, host, {
      previewId: preview.id,
      confirmDestination: true,
    });
    await saveDiscovery(db, who, host, {
      previewId: preview.id,
      confirmDestination: true,
    });
    // One batch: the first run commits everything, and a retry writes nothing more.
    // Staging runs the Wiki's own mutation documents, the ones chat agents run.
    assert.deepEqual((writes as { action: string; input: { operationName?: string } }[]).map((w) => w.input.operationName ?? w.action),
      ["batch.open", "StageChanges", "SubmitBatch"]);
    const activity = await discoveryActivity(db, who) as { events: {kind: string; at: string}[] };
    assert.equal(activity.events.filter(e => e.kind === "import").length, 1);
    assert.equal(activity.events.filter(e => e.kind === "run").length, 2);
    assert.equal(activity.events.filter(e => e.kind === "saved").length, 1);
    const detail = await discoveryActivity(db, who, preview.id) as { run: Record<string, unknown>; preview: unknown };
    assert.ok(detail.run.input && detail.run.output && detail.preview);
    assert.match(String(detail.run.systemPrompt), /Name: Alice/);
    await assert.rejects(discoveryActivity(db, other, history[0].id), status(404));
    assert.deepEqual((await discoveryActivity(db, other) as {events: unknown[]}).events, []);
    assert.deepEqual(writes[0], {
      installationId: "wiki",
      action: "batch.open",
      input: {
        title: `First discovery ${preview.createdAt.slice(0, 10)}`,
        purpose: "What Forerunner found on its first run.",
        source: { kind: "discovery-run", ref: preview.id, label: "Forerunner discovery" },
        policy: { kind: "first-run", version: "forerunner-discovery-2026-11" },
      },
    });
    const added = (writes[1] as { input: { variables: { input: { proposals: { operation: unknown; evidence: { provider: string; recordId: string; observedAt?: string }[]; confidence: number }[] } } } }).input.variables.input.proposals;
    assert.deepEqual(added.map((p) => p.operation), preview.operations);
    assert.ok(added.every((p) => p.evidence.length > 0 && p.confidence > 0));
    // Cited as a chat agent would: account and message id, with the message's date.
    const email = added.flatMap((p) => p.evidence).find((e) => e.provider === "gmail");
    assert.deepEqual([email?.recordId, email?.observedAt], ["alice@example.test/msg-1", "2026-10-28T00:00:00.000Z"]);
    const saved = await getPreview(db, who, preview.id);
    assert.deepEqual(saved?.receipt, { batchId: "b0000000-0000-4000-8000-000000000001", state: "committed", reviewBy: null, counts: { committed: 1 }, waiting: [] });
  } finally {
    client.close();
  }
});

test("partial connector failure is visible and never invents Wiki entries", async () => {
  const client = createClient({ url: ":memory:" }),
    db = drizzle(client);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  const host = {
    call: async (name: string, input: Record<string, unknown>) => {
      if (name === "entities.types")
        return ["graph-type", "graph-node", "graph-edge"].map((type) => ({
          type,
          installationId: "wiki",
          writable: true,
        }));
      if (name === "actions.call" && input.action === "graph.read") return wikiGraphFixture("wiki", {});
      if (name === "identity.current") return { id: "alice", name: "Alice", email: "alice@example.test" };
      if (name === "snapshot") return { connections: [] };
      throw new Error(name);
    },
  } as unknown as WorkflowHost<"interactive">;
  try {
    await assert.rejects(previewDiscovery(db, who, host, { sources: ["connection:revoked"] }), status(409));
    assert.equal(await getPreview(db, who), null);
    const history = await discoveryRuns(db, who) as { id: string; status: string }[];
    assert.equal(history[0].status, "failed");
    const run = await discoveryRuns(db, who, history[0].id) as Record<string, unknown>;
    assert.match(String(run.error), /Wiki has no active discovery entity types/);
    assert.equal(run.failedWhile, "preparing", "a failed run records the step it failed in");
    const activity = await discoveryActivity(db, who, history[0].id) as { preview: unknown; run: Record<string, unknown> };
    assert.equal(activity.preview, null);
    assert.equal(activity.run.status, "failed");
  } finally {
    client.close();
  }
});

test("feedback and corrections are private, typed and scoped to this run's saved edges", async () => {
  const { evaluateRun, correctMatch, matchCandidates, correctionInput, matchesInput } = await import("../src/server/discovery-feedback");
  const client = createClient({ url: ":memory:" }), db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const personType=id(1), productType=id(2), original=id(3), target=id(4), wrongType=id(5), edge=id(6), previewId=id(7);
  const record=(type:string, rid:string, attributes:Record<string,unknown>)=>({ref:{installationId:"wiki",type,id:rid},revision:1,attributes});
  const nodes=[record("graph-node",original,{title:"Bob",typeId:personType}),record("graph-node",target,{title:"Robert",typeId:personType}),record("graph-node",wrongType,{title:"Product",typeId:productType})];
  const edges=[record("graph-edge",edge,{fromId:original,toId:wrongType,typeId:id(8)})];
  const changes: unknown[]=[];
  const host={call:async(name:string,input:Record<string,unknown>)=>{
    if(name==="entities.types")return ["graph-type","graph-node","graph-edge"].map(type=>({type,installationId:"wiki",writable:true}));
    if(name==="actions.call" && input.action === "graph.read") return wikiGraphFixture("wiki", { nodes, edges });
    if(name==="actions.call"){changes.push(input);return {};}
    throw new Error(name);
  }} as unknown as WorkflowHost<"interactive">;
  const entryIndex = 137;
  const preview={id:previewId,version:7,receipt:{},entries:[...Array.from({length:entryIndex},(_,i)=>({id:id(100+i),typeId:personType,title:`Other ${i}`,kind:"Person",existing:false,excerpt:"Other evidence"})),{id:original,typeId:personType,title:"Bob",kind:"Person",existing:false,excerpt:"Evidence"}],wikiInstallationId:"wiki",operations:[{operation:"create",type:"graph-edge",ref:"$edge",attributes:{id:edge,typeId:id(8),fromId:original,toId:wrongType}}]};
  try {
    await client.execute({sql:"INSERT INTO forerunner_discovery_records (id, installationId, ownerId, kind, data, createdAt) VALUES (?, ?, ?, 'preview', ?, ?)",args:[previewId,who.installationId,who.userId,JSON.stringify(preview),Date.now()]});
    const feedback={previewId,requestId:id(9),rating:"mixed" as const,note:"Wrong match"};
    await evaluateRun(db,who,feedback);await evaluateRun(db,who,feedback);
    assert.equal((await getPreview(db,who,previewId))?.evaluations?.length,1);
    await assert.rejects(evaluateRun(db,{...who,userId:"other"},feedback),status(404));
    const matches=await matchCandidates(db,who,host,matchesInput.parse({previewId,entryIndex:String(entryIndex),query:""}));
    await assert.rejects(matchCandidates(db,who,host,matchesInput.parse({previewId,entryIndex:entryIndex+1,query:""})),status(400));
    assert.deepEqual(matches.candidates.map(c=>c.id),[original,target]);
    const correction=correctionInput.parse({previewId,requestId:id(10),entryIndex,expectedId:original,targetId:target,note:"Known friend"});
    assert.equal(correctionInput.safeParse({...correction,entryIndex:-1}).success,false);
    assert.equal(matchesInput.safeParse({previewId,entryIndex:"1.5"}).success,false);
    await assert.rejects(correctMatch(db,who,host,{...correction,targetId:wrongType}),status(400));
    const result=await correctMatch(db,who,host,correction);
    assert.equal(result.entries[entryIndex].matchedId,target);
    assert.equal(result.entries[entryIndex].matchedTitle,"Robert");
    assert.equal(changes.length,1);
    assert.deepEqual((changes[0] as {input:{operations:unknown[]}}).input.operations,[{operation:"update",type:"graph-edge",ref:"$correction0",id:edge,revision:1,attributes:{fromId:target,toId:wrongType}}]);
    await correctMatch(db,who,host,correction);assert.equal(changes.length,1);
  } finally {client.close();}
});

test("the knowledge graph index is one row per record, attributed to the run that created it, pending as the Wiki says now", async () => {
  const { discoveredEntities } = await import("../src/server/discovery");
  const client = createClient({ url: ":memory:" }), db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const bob = id(1), loft = id(2), edge = id(3), older = id(10), newer = id(11), unsaved = id(12), stale = id(13);
  const reads: unknown[] = [];
  const host = { call: async (name: string, input: Record<string, unknown>) => {
    if (name === "actions.call" && input.action === "batch.get") {
      reads.push(input);
      // The Wiki has since approved the loft; Bob still waits.
      return { batch: { id: (input.input as { batchId: string }).batchId, state: "open", reviewBy: null }, counts: {},
        operations: [{ ref: "$bob", state: "awaiting_review", operation: { attributes: { id: bob } } }, { ref: "$loft", state: "committed", operation: { attributes: { id: loft } } }] };
    }
    throw new Error(name);
  } } as unknown as WorkflowHost<"interactive">;
  const preview = (over: Record<string, unknown>) => ({ version: 7, systemPrompt: "", warnings: [], wikiInstallationId: "wiki", destination: "personal", operations: [], ...over });
  const insert = (rid: string, data: unknown, createdAt: number) => client.execute({ sql: "INSERT INTO forerunner_discovery_records (id, installationId, ownerId, kind, data, createdAt) VALUES (?, ?, ?, 'preview', ?, ?)", args: [rid, who.installationId, who.userId, JSON.stringify(data), createdAt] });
  try {
    await insert(older, preview({ id: older, createdAt: "2026-11-01T08:00:00Z", savedAt: "2026-11-01T08:05:00Z", sources: [{ label: "gmail · alice@example.test", count: 3, method: "connector", window: "14d" }],
      entries: [{ id: bob, title: "Bob", kind: "Person", existing: false, excerpt: "" }, { id: loft, title: "Bob's loft", kind: "Place", existing: false, excerpt: "" }, { title: "Bob hosts at the loft", kind: "Proposed relationship", existing: false, excerpt: "" }],
      operations: [{ operation: "create", type: "graph-edge", ref: "$edge", attributes: { id: edge, fromId: bob, toId: loft } }],
      batch: { installationId: "wiki", batchId: id(20), policy: "first-run" }, receipt: { waiting: [bob, loft] } }), 1);
    await insert(newer, preview({ id: newer, createdAt: "2026-11-02T08:00:00Z", savedAt: "2026-11-02T08:05:00Z", sources: [{ label: "google-calendar · alice@example.test", count: 1, method: "connector", window: "7d" }],
      entries: [{ id: bob, title: "Bob", kind: "Person", existing: true, matchedId: bob, excerpt: "" }, { id: id(4), title: "Salon dinner", kind: "Event", existing: false, excerpt: "" }],
      batch: { installationId: "wiki", batchId: id(21), policy: "confidence" }, receipt: { waiting: [] } }), 2);
    await insert(unsaved, preview({ id: unsaved, createdAt: "2026-11-03T08:00:00Z", sources: [], entries: [{ id: id(5), title: "Not saved", kind: "Person", existing: false, excerpt: "" }] }), 3);
    await insert(stale, preview({ id: stale, version: 6, createdAt: "2026-10-01T08:00:00Z", savedAt: "2026-10-01T08:05:00Z", sources: [], entries: [{ id: id(6), title: "Old format", kind: "Person", existing: false, excerpt: "" }] }), 0);
    const { entities } = await discoveredEntities(db, who, host);
    assert.deepEqual(entities.map((e) => [e.title, e.kind, e.status, e.foundIn, e.links, e.runId]), [
      ["Salon dinner", "Event", "accepted", ["Google Calendar"], 0, newer],
      ["Bob", "Person", "pending", ["Gmail"], 1, older],
      ["Bob's loft", "Place", "accepted", ["Gmail"], 1, older],
    ]);
    assert.deepEqual(entities.map((e) => e.batchId), [undefined, id(20), undefined], "a pending row names the batch to review it in");
    assert.equal(reads.length, 1, "only batches with something waiting are read from the Wiki");
    await assert.rejects(discoveredEntities(db, { ...who, canEdit: false }, host), status(403));
    assert.deepEqual((await discoveredEntities(db, { ...who, userId: "other" }, host)).entities, []);
  } finally { client.close(); }
});

test("registered 30-day Gmail task executes source-read, analysis and Wiki save, retaining completion before reply", async () => {
  const {runDiscoveryTask} = await import('../src/server/tasks');
  const client = createClient({url:':memory:'}), db = drizzle(client);
  await migrate(db,{migrationsFolder:fileURLToPath(new URL('../migrations',import.meta.url))});
  const calls: {name:string;input:Record<string,unknown>}[] = [];
  let batchState = 'open';
  const connectorReply=(input:Record<string,unknown>)=>{
      assert.equal(input.connectionId,'gmail-alice');assert.equal(input.resource,'alice@example.test');
      if(input.operation === 'messages.list') {
        const query=(input.input as {query:string}).query;
        const after=Number(query.match(/after:(\d+)/)?.[1]);
        assert.ok(Math.abs(Date.now()/1000-after-30*86400)<10,'uses the requested 30-day read window');
        return {messages:[{id:'synthetic-message'}]};
      }
      return {id:'synthetic-message',subject:'Review draft with Bob',snippet:'Draft review',text:'Bob will review the draft.',from:'Bob <bob@example.test>',date:new Date().toISOString()};
  };
  const host = {call:async(name:string,input:Record<string,unknown>) => {
    calls.push({name,input});
    const fixed:Record<string,unknown> = {'identity.current':{id:'alice',name:'Alice',email:'alice@example.test'},snapshot:{connections:[{id:'gmail-alice',resource:'alice@example.test',provider:'gmail',label:'Alice'}]},'session.append':{},'workflow.collect':{},'inference.generate':{output:semantic}};
    if (name in fixed) return fixed[name];
    if (name === 'entities.types') return ['graph-type','graph-node','graph-edge'].map(type=>({type,installationId:'wiki',writable:true}));
    if (name === 'actions.call' && input.action === 'graph.read') return wikiGraphFixture('wiki',{types:defaults.map(t=>({ref:{installationId:'wiki',type:'graph-type',id:t.id},attributes:t}))});
    if (name === 'actions.call') {const reply=wikiBatch(input,batchState);batchState=reply.state;return reply.body;}
    if (name === 'workflow.start') return {id:String(input.id),created:true};
    if (name === 'connector.execute') return connectorReply(input);
    throw new Error(name);
  }} as unknown as WorkflowHost<'interactive'>;
  try {
    const taskId='10000000-0000-4000-8000-000000000099';
    const result=await runDiscoveryTask(db,who,{runId:taskId,task:'forerunner-discovery',inputs:{sources:['connection:gmail-alice'],range:'30d'}},host);
    assert.equal(result.status,'ready');assert.ok(result.previewId && result.batchId && result.savedAt);
    assert.ok(calls.some(c=>c.name==='connector.execute' && c.input.operation==='messages.get'));
    assert.equal(calls.filter(c=>c.name==='workflow.start').length,0,'task already owns its workflow claim');
    assert.ok(calls.filter(c=>c.name==='inference.generate').every(c=>c.input.runId===taskId),'usage belongs to the durable task receipt');
    const progress=calls.filter(c=>c.name==='workflow.collect' && c.input.complete===false).map(c=>(c.input.value as {status:string}).status);
    assert.deepEqual(progress,['preparing','reading','analyzing','saving']);
    assert.equal(calls.filter(c=>c.name==='workflow.collect' && c.input.complete!==false).length,1,'only the full lifecycle publishes completion');
    assert.ok(calls.some(c=>c.name==='actions.call' && (c.input.input as {operationName?:string})?.operationName==='SubmitBatch'));
    const completion=calls.at(-1);assert.equal(completion?.name,'workflow.collect');assert.equal(completion?.input.runId,taskId);assert.deepEqual(completion?.input.value,result);
    const preview=await getPreview(db,who,String(result.previewId));assert.ok(preview?.savedAt);
    const runs=await discoveryRuns(db,who) as {taskId:string;status:string}[];
    const retained=await discoveryRuns(db,who,(runs[0] as unknown as {id:string}).id) as {taskId:string};
    assert.equal(retained.taskId,taskId);assert.equal(runs[0].status,'complete');
    await assert.rejects(runDiscoveryTask(db,{...who,canEdit:false},{runId:taskId,task:'forerunner-discovery',inputs:{sources:['connection:gmail-alice'],range:'30d'}},host),status(403));
  } finally {client.close();}
});
