import test from "node:test";
import assert from "node:assert/strict";
import { core } from "../src/lib/graph";
import { rejectNewOwnerBindingAmbiguity } from "../src/server/owner-root-bindings";
const node=(id:string,owner:string,archived=false)=>({id,typeId:core.organization,archived,properties:{organization_id:owner}});
test("owner binding import check rejects new ambiguity, preserves legacy ambiguity and permits foreign context",()=>{
  const a=node("a","one"),b=node("b","one"),other=node("c","two");
  assert.throws(()=>rejectNewOwnerBindingAmbiguity([a],[a,b]),e=>e instanceof Response&&e.status===409);
  assert.doesNotThrow(()=>rejectNewOwnerBindingAmbiguity([a,b],[a,b,other]));
  assert.doesNotThrow(()=>rejectNewOwnerBindingAmbiguity([a],[a,other]));
  assert.doesNotThrow(()=>rejectNewOwnerBindingAmbiguity([a],[a,node("b","one",true)]));
  assert.throws(()=>rejectNewOwnerBindingAmbiguity([a,node("b","one",true)],[a,b]));
});
