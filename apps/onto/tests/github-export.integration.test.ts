import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { migrateAppDatabase } from "@ai-outfitter/app-sdk/migrations";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import { putDefinition, createDocument, readLive, enqueue, lease, complete, type Host } from "../src/server/documents/service";
import { prepareExport, publishGithub, renderDocument } from "../src/server/exports/github";
const sha="a".repeat(40), head="b".repeat(40);
const period={start:"2026-01-01T00:00:00Z",end:"2026-02-01T00:00:00Z"};
async function fixture() {
  const client=createClient({url:"file::memory:"});
  await client.executeMultiple(await readFile(new URL("../migrations/0013_documents.sql",import.meta.url),"utf8"));
  await migrateAppDatabase({query:async sql=>(await client.execute(sql)).rows as unknown as Record<string,unknown>[],batch:async statements=>{await client.batch(statements,"write");}},
    [{name:"0014_publications",sql:await readFile(new URL("../migrations/0014_publications.sql",import.meta.url),"utf8")}]);
  const db:AgentDatabase={query:async s=>(await client.execute({sql:s.sql,args:s.params as never[]})).rows as unknown as Record<string,unknown>[],batch:async ss=>client.batch(ss.map(s=>({sql:s.sql,args:s.params as never[]})),"write")};
  const scope={owner:"org"}; const access:Host={read:async()=>({complete:true,provenance:{period:"fixture"},snapshot:{value:1}}),verifyCapture:async()=>true,policy:async binding=>({binding,decision:"allow"}),deliver:async()=>null};
  await putDefinition(db,scope,"definition",1,{sources:[{provider:"graph",config:"x"}],policy:{provider:"policy",config:"v1",required:true}});
  await createDocument(db,scope,"report","definition",1); const capture=await readLive(db,scope,"report",access);
  await enqueue(db,scope,"report","j"); await lease(db,scope,"j","token",1,10); const revision=await complete(db,scope,"j","token",2,{document:{title:"Weekly roadmap",markdown:"# Weekly roadmap\n\nEvidence-backed report."},provenance:{period}},capture);
  const input={publicationId:"request",documentId:"report",revision:1,digest:revision.digest,readConnectionId:"reader",writeConnectionId:"writer",resource:"42",repository:"team/repo",baseBranch:"main",baseSha:sha,path:"reports/report.md",period:{start:"2026-01-01T00:00:00Z",end:"2026-02-01T00:00:00Z"}};
  return {client,db,scope,access,input};
}
test("disclosure and policy are rechecked for the exact revision",async t=>{
  const f=await fixture();t.after(()=>f.client.close());
  await assert.rejects(prepareExport(f.db,f.scope,{...f.access,verifyCapture:async()=>false},f.input));
  await assert.rejects(prepareExport(f.db,f.scope,{...f.access,policy:async binding=>({binding:{...binding,digest:"stale"},decision:"allow"})},f.input));
  const a=await prepareExport(f.db,f.scope,f.access,f.input), b=await prepareExport(f.db,f.scope,f.access,f.input);
  assert.equal(a.markdown,b.markdown); assert.match(a.markdown,new RegExp(f.input.digest)); assert.match(a.markdown,/sources:/); assert.match(a.markdown,/# Weekly roadmap\n\nEvidence-backed report\./); assert.doesNotMatch(a.markdown,/```json/);
  await assert.rejects(prepareExport(f.db,f.scope,f.access,{...f.input,period:{...period,end:"2026-03-01T00:00:00Z"}}),error=>error instanceof Response && error.status===409);
});
test("uses separate read and write connections, records receipt and does not replay writes",async t=>{
  const f=await fixture();t.after(()=>f.client.close()); const calls:{op:string,input:any}[]=[]; let currentBase=sha;
  const host={call:async(op:string,input:any)=>{calls.push({op,input});if(op==="repository.request") return input.path.endsWith("/main")?{commit:{sha:currentBase}}:{id:42,full_name:"team/repo"};
    if(input.operation==="repositories.commit") return {branch:input.input.branch,headSha:head,treeSha:sha,url:"https://example.test/commit"};
    return {number:3,html_url:"https://example.test/pr",draft:true,head:{sha:head,ref:input.input.head},base:{ref:"main"}};}};
  const result=await publishGithub(f.db,f.scope,host as never,f.access,f.input); assert.equal(result.number,3);
  currentBase=head;
  assert.deepEqual(await publishGithub(f.db,f.scope,host as never,f.access,f.input),result,"completed receipt survives unrelated base advancement");
  await assert.rejects(publishGithub(f.db,f.scope,host as never,{...f.access,verifyCapture:async()=>false},f.input),"receipt reads still require current source authorization");
  assert.equal(calls.filter(c=>c.op==="connector.execute").length,2);
  assert.ok(calls.filter(c=>c.op==="repository.request").every(c=>c.input.connectionId==="reader"));
  assert.ok(calls.filter(c=>c.op==="connector.execute").every(c=>c.input.connectionId==="writer"));
});
test("uncertain commit blocks repeat, and branch conflicts prevent writes",async t=>{
  const f=await fixture();t.after(()=>f.client.close());let writes=0;
  const host={call:async(op:string,input:any)=>{if(op==="repository.request") return input.path.endsWith("/main")?{commit:{sha}}:{id:42,full_name:"team/repo"};writes++;throw new Error("unknown outcome");}};
  await assert.rejects(publishGithub(f.db,f.scope,host as never,f.access,f.input)); await assert.rejects(publishGithub(f.db,f.scope,host as never,f.access,f.input)); assert.equal(writes,1);
  const other={...f.input,publicationId:"other"};const conflict={call:async(_op:string,input:any)=>input.path.endsWith("/main")?{commit:{sha:head}}:{id:42,full_name:"team/repo"}};
  await assert.rejects(publishGithub(f.db,f.scope,conflict as never,f.access,other));
});

for (const target of ["committing", "opening"] as const)
  test(`a concurrent revision change blocks the ${target} write claim`, async t => {
    const f=await fixture();t.after(()=>f.client.close()); let injected=false, writes=0;
    const raced:AgentDatabase={...f.db,batch:async statements=>{
      if (!injected && statements.some(s=>s.sql.startsWith("UPDATE document_publications SET state=?") && s.params?.[0]===target)) {
        injected=true;
        const capture=await readLive(f.db,f.scope,"report",f.access);
        await enqueue(f.db,f.scope,"report","concurrent");
        await lease(f.db,f.scope,"concurrent","new-token",3,10);
        await complete(f.db,f.scope,"concurrent","new-token",4,{document:{title:"New revision",markdown:"Superseding report"},provenance:{period}},capture);
      }
      return f.db.batch(statements);
    }};
    const host={call:async(operation:string,input:any)=>{
      if (operation==="repository.request") return input.path.endsWith("/main")?{commit:{sha}}:{id:42,full_name:"team/repo"};
      writes++;
      if(input.operation==="repositories.commit") return {branch:input.input.branch,headSha:head,treeSha:sha,url:"https://example.test/commit"};
      return {number:3,html_url:"https://example.test/pr",draft:true,head:{sha:head,ref:input.input.head},base:{ref:"main"}};
    }};
    await assert.rejects(publishGithub(raced,f.scope,host as never,f.access,f.input));
    assert.equal(injected,true);
    assert.equal(writes,target==="committing"?0:1,"superseded evidence must not reach the next connector write");
    const [publication]=await f.db.query({sql:"SELECT state FROM document_publications WHERE owner=? AND id=?",params:[f.scope.owner,f.input.publicationId]});
    assert.equal(publication.state,target==="committing"?"planned":"committed","failed claim must roll back its state transition");
  });


test("export formats preserve provenance and apply only explicit Obsidian link mappings",async t=>{
  const f=await fixture();t.after(()=>f.client.close());
  const prepared=await prepareExport(f.db,f.scope,f.access,f.input);
  const revision={...prepared.revision,payload:{document:{title:"Report",markdown:"[Story](https://example.test/story)\n`[Code](https://example.test/story)`"},provenance:{period}}};
  const options={...f.input,frontmatter:{tags:["roadmap"],document:"custom cannot replace identity"},vaultLinks:[{url:"https://example.test/story",path:"Stories/one"}]};
  const ordinary=renderDocument({...options,format:"markdown"},revision);
  const obsidian=renderDocument({...options,format:"obsidian"},revision);
  assert.match(ordinary,/\[Story\]\(https:\/\/example.test\/story\)/);
  assert.match(obsidian,/\[\[Stories\/one\|Story\]\]/);
  assert.match(obsidian,/`\[Code\]\(https:\/\/example.test\/story\)`/);
  assert.match(obsidian,/document: "report"/); assert.match(obsidian,/custom: .*roadmap/);
  assert.match(obsidian,new RegExp(f.input.digest));
});
