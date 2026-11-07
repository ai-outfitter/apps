import assert from "node:assert/strict";
import test from "node:test";
import { defaultContract, renderTemplate } from "../src/server/documents/render";
import type { DocumentContract } from "../src/server/documents/service";

test("issue definitions select attributable context and expose missing acceptance criteria without publication",()=>{
  const contract:DocumentContract={...defaultContract,identity:"example.feature",rendering:{mode:"template",template:"feature-issue",title:"Feature: export graph",sections:[{title:"Use cases",provider:"planning",pointer:"/useCases",required:true},{title:"Acceptance criteria",provider:"planning",pointer:"/acceptanceCriteria",required:true}]}};
  const result=renderTemplate(contract,{complete:true,errors:[],sources:[{provider:"planning",config:"selected",provenance:{revision:7},snapshot:{useCases:[{id:"uc-1",text:"Export selected graph"}]}}]});
  assert.match(result.markdown,/uc-1/); assert.match(result.markdown,/Missing required context\n\n- Acceptance criteria/); assert.match(result.markdown,/Publication: STUB/);
  assert.doesNotMatch(result.markdown,/undefined/);
});

test("section lookup handles JSON Pointer escaping and refuses inherited or ambiguous selections",()=>{
  const contract:DocumentContract={...defaultContract,rendering:{mode:"template",template:"evidence",sections:[{title:"Escaped",provider:"p",pointer:"/a~1b/~0value",required:true},{title:"Unsafe",provider:"p",pointer:"/__proto__",required:true}]}};
  const source={provider:"p",config:"c",provenance:{},snapshot:{"a/b":{"~value":"Selected evidence"}}};
  const result=renderTemplate(contract,{complete:true,errors:[],sources:[source]});
  assert.match(result.markdown,/Selected evidence/); assert.match(result.markdown,/Missing required context\n\n- Unsafe/);
  assert.doesNotMatch(renderTemplate(contract,{complete:true,errors:[],sources:[source,source]}).markdown,/Selected evidence/);
});
