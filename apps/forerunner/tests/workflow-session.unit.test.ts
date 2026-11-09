import assert from "node:assert/strict";
import test from "node:test";
import {replayAdapter} from "../evals/workflow-sessions/replay";
import {answer, capturedSession} from "./helpers/workflow-session";

test('a downloaded checkpoint replays production batching, confidence, validation and proposals without a writable host',async()=>{
 const original=await capturedSession();const before=JSON.stringify(original);const calls:any[]=[];
 const adapter=replayAdapter(async(request)=>{calls.push(request);return {output:answer(request),finishReason:'stop',usage:{inputTokens:20,outputTokens:10,totalTokens:30}}});
 const result=await adapter.replay(original,'analysis',{maxOutputTokens:8000,instructions:'Changed prompt',batchBudget:20000});
 assert.equal(result.session.run.status,'complete');assert.ok(calls.length>2);assert.ok(calls.every(c=>c.settings.maxOutputTokens===8000&&c.instructions==='Changed prompt'));
 assert.equal(new Set(calls.flatMap(c=>c.data.evidence.filter((e:any)=>e.ref!=='operating-user').map((e:any)=>e.ref))).size,40);
 assert.equal(JSON.stringify(original),before);assert.equal(result.session.branch?.sessionId,original.run.id);
 assert.ok((result.output as any).operations.length>0);
 calls.length=0;const batch=await adapter.replay(original,'analysis.batch.1',{});
 assert.equal(batch.session.run.status,'complete');assert.equal(calls.length,1);
 assert.deepEqual(calls[0].data,(original.entries.find(e=>e.id==='analysis.batch.1')!.data as any).data);
});
test('a 4000 token failure remains inspectable and an increased budget completes the same captured inputs',async()=>{
 const original=await capturedSession();
 const adapter=replayAdapter(async(request)=>{
  if(request.settings.maxOutputTokens===4000)throw new Error('Inference output token limit');
  return {output:answer(request),finishReason:'stop'};
 });
 // Production now asks for 16000 tokens (#794); replay the old 4000 budget.
 const failed=await adapter.replay(original,'analysis',{maxOutputTokens:4000});assert.equal(failed.session.run.status,'failed');
 assert.match(JSON.stringify(failed.session.entries),/token limit/);
 const fixed=await adapter.replay(original,'analysis',{maxOutputTokens:16000});assert.equal(fixed.session.run.status,'complete');
 assert.deepEqual((fixed.session.entries.find(e=>e.kind==='inference-start')!.data as any).data,(failed.session.entries.find(e=>e.kind==='inference-start')!.data as any).data);
 await assert.rejects(adapter.replay({...original,entries:[]},'analysis',{}),/Unsupported replay/);
 await assert.rejects(adapter.replay(original,'analysis.batch.0',{batchBudget:10000}),/Change batching/);
});

test('local inference preserves the captured Responses transport and untrusted-data framing',async t=>{
  const {liveInference}=await import('../evals/workflow-sessions/replay');
  const {inferenceRequest}=await import('@ai-outfitter/app-sdk/workflow-inference');
  const original=globalThis.fetch;const oldKey=process.env.WORKFLOW_EVAL_API_KEY,oldUrl=process.env.WORKFLOW_EVAL_BASE_URL;
  t.after(()=>{globalThis.fetch=original;if(oldKey===undefined)delete process.env.WORKFLOW_EVAL_API_KEY;else process.env.WORKFLOW_EVAL_API_KEY=oldKey;if(oldUrl===undefined)delete process.env.WORKFLOW_EVAL_BASE_URL;else process.env.WORKFLOW_EVAL_BASE_URL=oldUrl;});
  process.env.WORKFLOW_EVAL_API_KEY='synthetic-key';process.env.WORKFLOW_EVAL_BASE_URL='https://provider.example.test/v1';
  globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'https://provider.example.test/v1/responses');
    assert.match(String(init?.body),/untrusted/);
    return Response.json({id:'response',object:'response',created_at:1,status:'completed',model:'test-model',output:[{id:'message',type:'message',role:'assistant',content:[{type:'output_text',text:'{"ok":true}',annotations:[]}]}],usage:{input_tokens:20,output_tokens:5,total_tokens:25}});
  };
  const request=inferenceRequest('Instructions',{source:'untrusted words'},{type:'object',additionalProperties:false,required:['ok'],properties:{ok:{type:'boolean'}}},{api:'responses',maxOutputTokens:4000,timeoutMs:1000});
  assert.deepEqual((await liveInference(request,'test-model')).output,{ok:true});
});
