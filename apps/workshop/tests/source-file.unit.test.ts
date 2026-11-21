import assert from "node:assert/strict";
import {test} from "node:test";
import {readSourceFile,sourceFileInput} from "../src/server/source-file";
import type {WorkshopContext} from "../src/server/graphql";

test("read a file through the connected Forgejo repository with a dotted owner",async()=>{
  const calls:unknown[]=[];
  const input=sourceFileInput.parse({repository:"ks.systems/hardware",path:"assemblies/pico.scad",ref:"main"});
  const host={call:async(op:string,args:unknown)=>{
    if(op==="snapshot")return {connections:[{provider:"forgejo",id:"hardware",repositories:[input.repository]}]};
    calls.push(args);
    return {type:"file",path:input.path,size:3,sha:"a".repeat(40),encoding:"base64",content:"Q0FE"};
  }};
  const result=await readSourceFile({host:()=>host} as unknown as WorkshopContext,input);
  assert.deepEqual(calls,[{connectionId:"hardware",path:"/repos/ks.systems/hardware/contents/assemblies/pico.scad?ref=main"}]);
  assert.equal(atob(result.content),"CAD");
  assert.equal(sourceFileInput.safeParse({...input,path:"../other"}).success,false);
});
