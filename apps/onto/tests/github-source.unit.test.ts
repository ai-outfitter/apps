import assert from "node:assert/strict";
import test from "node:test";
import { captureGithub } from "../src/server/sources/github";
const input = {connectionId:"read",repository:"team/repo",branch:"main",start:"2026-01-01T00:00:00Z",end:"2026-02-01T00:00:00Z"};
const sha = "a".repeat(40);
const pr = (number:number, date:string) => ({number,title:"PR",html_url:"https://example.test/pr",merged_at:date,base:{ref:"main"},head:{sha},merge_commit_sha:sha});
const commit = (date:string) => ({sha,html_url:"https://example.test/commit",commit:{message:"work",committer:{date}}});
test("source uses merged and committer timestamps, half-open bounds and deduplicates", async () => {
  const calls:string[]=[];
  const host = {call:async (_:unknown, raw:unknown) => {const {path}=raw as {path:string};calls.push(path);if (path.includes("/git/ref/")) return {object:{sha}};return path.includes("/pulls?") ? [pr(1,input.start),pr(1,input.start),pr(2,input.end)] : [commit(input.start),commit(input.start),commit(input.end)];}};
  const result=await captureGithub(host as never,input);
  assert.equal(result.complete,true); assert.equal(result.snapshot.mergedPullRequests.length,1); assert.equal(result.snapshot.commits.length,1);
  assert.ok(calls.every(path=>path.startsWith("/repos/team/repo/"))); assert.equal(result.provenance.period.boundary,"[start,end)");
});
test("source preserves authorization failures and pagination limits as incomplete", async () => {
  const denied = await captureGithub({call:async()=>{throw new Response("denied",{status:403});}} as never,input);
  assert.equal(denied.complete,false); assert.ok(denied.errors.length >= 2);
  const capped = await captureGithub({call:async (_:unknown, raw:unknown)=> (raw as {path:string}).path.includes("/git/ref/") ? {object:{sha}} : (raw as {path:string}).path.includes("/pulls?") ? Array.from({length:100},(_,i)=>pr(i+1,input.start)) : []} as never,input);
  assert.equal(capped.complete,false); assert.match(capped.errors.join("; "),/pagination limit/);
});

test("mutable pagination overlap stays deduplicated but cannot claim complete coverage",async()=>{
  const host={call:async (_:unknown,raw:unknown)=>{
    const path=(raw as {path:string}).path;
    if(path.includes("/git/ref/")) return {object:{sha}};
    if(!path.includes("/pulls?")) return [];
    return path.endsWith("page=1") ? Array.from({length:100},(_,i)=>pr(i+1,input.start)) : [pr(100,input.start)];
  }};
  const result=await captureGithub(host as never,input);
  assert.equal(result.complete,false); assert.match(result.errors.join(" "),/pagination drift/);
  assert.equal(result.snapshot.mergedPullRequests.length,100);
});
