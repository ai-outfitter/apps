import assert from "node:assert/strict";
import test from "node:test";
import { movePortfolioItem } from "../src/portfolio-order";
import { projectNextAction } from "../src/project-next-action";
test("project attention preserves separate persisted decisions and explicit incomplete coverage",()=>{
  const view=projectNextAction({intakeDecisions:{items:[{intakeId:"a",title:"Shared title",revision:2,questions:["Which release?"]},{intakeId:"b",title:"Shared title",revision:3,questions:["Which release?"]},{intakeId:"done",questions:[]}],truncated:true}},{summary:"Two observed changes",status:"incomplete",reference:{slug:"project-note",revision:7}});
  assert.deepEqual(view.questions.map(row=>row.id),["a","b"]);assert.equal(view.truncated,true);assert.equal(view.incomplete,true);assert.equal(view.summary,"Two observed changes");assert.equal(view.reference.revision,7);
});
test("absent captures supply no invented questions or successful change summary",()=>{
  const view=projectNextAction(null,null);assert.deepEqual(view.questions,[]);assert.equal(view.summary,"");assert.equal(view.incomplete,false);
});


test("personal reorder retains unseen authorized records and refuses stale drag targets",()=>{
  const original=["unseen-project","sunny:a","personal:b","sunny:c"];
  assert.deepEqual(movePortfolioItem(original,"sunny:c","sunny:a"),["unseen-project","sunny:c","sunny:a","personal:b"]);
  assert.deepEqual(original,["unseen-project","sunny:a","personal:b","sunny:c"]);
  assert.equal(movePortfolioItem(original,"revoked-project","sunny:a"),null);
});


test("next action surfaces persisted Governance blockers and preparation questions before delivery",()=>{
  const view=projectNextAction({preparation:{id:"preparation",state:"prepared",projectRevision:4,blockers:[{code:"governance",message:"No active Governance work gate governs implementation work",remediation:"Add implementation to an active work gate's work kinds in Governance (a reviewed Wiki change)."}],questions:[{requirement:"Checkout",question:"Which payment provider?"}]},intakeDecisions:{items:[]}},null);
  assert.equal(view.blockers[0].message,"No active Governance work gate governs implementation work");assert.match(view.blockers[0].remediation,/reviewed Wiki change/);assert.deepEqual(view.questions[0].questions,["Checkout: Which payment provider?"]);
});
