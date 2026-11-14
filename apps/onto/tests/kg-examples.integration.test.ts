import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {appArtifact} from "@ai-outfitter/app-test/prepare";
import {appWorker} from "@ai-outfitter/app-test/worker";
import {adoptStandardDefinitions} from "../scripts/seed-kg-examples";

test("local examples adopt only unchanged imported standard definitions and retain provenance",async()=>{
 const app=await appWorker("onto",appArtifact(new URL("..",import.meta.url),"operational"));
 const directory=await mkdtemp(join(tmpdir(),"kg-example-provenance-"));
 try{
  const initialized=await app.call("/api/internal/app-initialize",{userId:"synthetic-owner",organizationId:"synthetic-org",role:"owner"},{method:"POST",body:{}});
  assert.equal(initialized.status,200);
  const role=await app.database.prepare("SELECT id,body FROM graph_nodes WHERE slug='role-context'").first<{id:string;body:string}>();
  const decision=await app.database.prepare("SELECT id,body FROM graph_nodes WHERE slug='decision-context'").first<{id:string;body:string}>();
  assert.ok(role);assert.ok(decision);
  const edited=JSON.stringify({...JSON.parse(decision.body),purpose:"A synthetic user authored a different definition"});
  await app.database.prepare("UPDATE graph_nodes SET createdBy='synthetic-imported-author',updatedBy='synthetic-imported-author' WHERE id IN (?,?)").bind(role.id,decision.id).run();
  await app.database.prepare("UPDATE graph_nodes SET body=? WHERE id=?").bind(edited,decision.id).run();
  await adoptStandardDefinitions(app.database,directory,"synthetic");
  const adopted=await app.database.prepare("SELECT body,createdBy FROM graph_nodes WHERE id=?").bind(role.id).first<{body:string;createdBy:string}>();
  assert.equal(adopted?.body,role.body);
  assert.equal(adopted?.createdBy,"seed:wiki-standard-data");
  const preserved=await app.database.prepare("SELECT body,createdBy FROM graph_nodes WHERE id=?").bind(decision.id).first<{body:string;createdBy:string}>();
  assert.equal(preserved?.body,edited);assert.equal(preserved?.createdBy,"synthetic-imported-author");
  const path=join(directory,"app-snapshots","synthetic");const files=await readdir(path);
  assert.equal(files.length,1);const backup=JSON.parse(await readFile(join(path,files[0]),"utf8"));
  assert.equal(backup[0].id,role.id);assert.equal(backup[0].createdBy,"synthetic-imported-author");
  await adoptStandardDefinitions(app.database,directory,"synthetic");
  assert.equal((await readdir(path)).length,1,"retry does not adopt again");
 }finally{await app.dispose();await rm(directory,{recursive:true,force:true});}
});
