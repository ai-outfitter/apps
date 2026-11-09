import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { graphql, print, GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql";
import { z } from "zod";
import { batchSchema, withBatchDocuments, resultInstructions } from "../src/batch-documents";
import { mutationField } from "../src/app-graphql";

const key=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
test("installation previews require confirmation for both retained result shapes",()=>{
  for (const preview of [{phase:"preview",previewToken:"token"},{preview:true,previewToken:"token"}]) {
    assert.deepEqual(resultInstructions(key(1),preview),[{
      code:"CONFIRM_INSTALL",itemKey:key(1),actor:"caller",required:true,
      message:"Review the installation preview, then confirm its previewToken using a new request key.",
    }]);
  }
  assert.deepEqual(resultInstructions(key(1),{phase:"installed"}),[]);
});
async function fixture(replayResult = true, authorizeReplay?: () => Promise<boolean>) {
  const client=createClient({url:":memory:"});
  await client.execute("CREATE TABLE graph_change_receipts (actor TEXT,document TEXT,request_key TEXT,fingerprint TEXT,claim TEXT,result TEXT,created_at INTEGER,PRIMARY KEY(actor,document,request_key))");
  const calls:string[]=[];
  const base=new GraphQLSchema({query:new GraphQLObjectType({name:"Query",fields:{health:{type:GraphQLString}}}),mutation:new GraphQLObjectType({name:"Mutation",fields:{
    save:mutationField({name:"Save",description:"Save a fixture",input:z.strictObject({title:z.string().min(1)}),run:async(context:{identity:{userId:string}},input)=>{
      if(context.identity.userId!=="alice")throw new Response("Denied",{status:403});
      calls.push(input.title);return {id:input.title};
    }}),
  }})});
  const groups={ItemChanges:{description:"Save fixture items",actions:{save:"save"},replayResult,authorizeReplay}};
  const schema=batchSchema(base,groups);
  const documents=withBatchDocuments({Save:{story:"As a user, I want to save one item, so that it is retained.",document:"mutation Save($input:SaveInput!){save(input:$input)}"}},schema,groups);
  const run=async(items:unknown[],userId="alice")=>{
    const response=await graphql({schema,source:print(documents.ItemChanges.document),variableValues:{input:{items}},contextValue:{db:()=>drizzle(client),identity:{userId},actor:{kind:"member",id:userId},originActor:{kind:"member",id:userId}}});
    assert.equal(response.errors,undefined,JSON.stringify(response.errors));return (response.data as any).itemChanges;
  };
  return {client,calls,run,documents};
}
test("ordered independent receipts validate each input, retain success, and refuse changed replays",async()=>{
  const f=await fixture();try{
    const items=[{key:key(1),action:"save",input:{title:"first"}},{key:key(2),action:"save",input:{title:""}},{key:key(3),action:"save",input:{title:"last"}}];
    const result=await f.run(items);
    assert.deepEqual(result.items.map((item:any)=>item.status),["complete","failed","complete"]);
    assert.deepEqual(result.instructions,[]);
    await f.run(items);assert.deepEqual(f.calls,["first","last"]);
    assert.equal((await f.run([{...items[0],input:{title:"changed"}}])).items[0].error.code,"IDEMPOTENCY_CONFLICT");
    assert.equal((f.documents.Save as { hidden?: boolean }).hidden,true);
  }finally{f.client.close();}
});
test("one actor cannot replay another actor's receipt",async()=>{
  const f=await fixture();try{
    const items=[{key:key(4),action:"save",input:{title:"private"}}];
    await f.run(items);
    const result=await f.run(items,"bob");
    assert.notEqual(result.items[0].status,"complete");assert.deepEqual(f.calls,["private"]);
  }finally{f.client.close();}
});
test("gated replay hides retained results without repeating the change",async()=>{
  const f=await fixture(false);try{
    const items=[{key:key(5),action:"save",input:{title:"private"}}];
    assert.equal((await f.run(items)).items[0].result.id,"private");
    const replay=await f.run(items);
    assert.equal(replay.items[0].status,"uncertain");
    assert.equal(replay.items[0].result,null);
    assert.equal(replay.instructions[0].code,"READ_BEFORE_RETRY");
    assert.deepEqual(f.calls,["private"]);
  }finally{f.client.close();}
});
test("replay returns a retained result only while current authorization allows it",async()=>{
  let authorized = true;
  const f=await fixture(false, async () => authorized);try{
    const items=[{key:key(6),action:"save",input:{title:"retained"}}];
    await f.run(items);
    assert.equal((await f.run(items)).items[0].result.id,"retained");
    authorized = false;
    assert.equal((await f.run(items)).items[0].result,null);
    assert.deepEqual(f.calls,["retained"]);
  }finally{f.client.close();}
});
test("batch execution without imported documents returns only declared GraphQL fields",async()=>{
  const client=createClient({url:":memory:"});
  await client.execute("CREATE TABLE graph_change_receipts (actor TEXT,document TEXT,request_key TEXT,fingerprint TEXT,claim TEXT,result TEXT,created_at INTEGER,PRIMARY KEY(actor,document,request_key))");
  try {
    const output=new GraphQLObjectType({name:"PublicRecord",fields:{id:{type:GraphQLString}}});
    const base=new GraphQLSchema({query:new GraphQLObjectType({name:"Query",fields:{health:{type:GraphQLString}}}),mutation:new GraphQLObjectType({name:"Mutation",fields:{save:mutationField({name:"Save",description:"Save",input:z.strictObject({title:z.string()}),output,run:()=>({id:"visible",secret:"private"})})}})});
    const schema=batchSchema(base,{ItemChanges:{description:"Save",actions:{save:"save"}}});
    const response=await graphql({schema,source:'mutation($input:ItemChangesInput!){itemChanges(input:$input){items{result}}}',variableValues:{input:{items:[{key:key(7),action:"save",input:{title:"x"}}]}},contextValue:{db:()=>drizzle(client),identity:{userId:"alice"},actor:{kind:"member",id:"alice"},originActor:{kind:"member",id:"alice"}}});
    assert.equal(response.errors,undefined,JSON.stringify(response.errors));
    assert.deepEqual({...((response.data as any).itemChanges.items[0].result)},{id:"visible"});
  } finally {client.close();}
});


test("an invalid draft asks the caller to repair it before submission", () => {
  const instructions = resultInstructions(key(99), { state: "open", validation: { valid: false, error: "Missing relationship" } });
  assert.deepEqual(instructions.map(instruction => instruction.code), ["REPAIR_CHANGES"]);
  assert.match(instructions[0].message, /Missing relationship/);
  assert.equal(resultInstructions(key(100), { state: "open", validation: { valid: true } })[0].code, "SUBMIT_CHANGES");
});
