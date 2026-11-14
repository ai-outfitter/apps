import assert from "node:assert/strict";
import test from "node:test";
import { reportMarkdown } from "../src/server/report-markdown";
import { intakeQuestions } from "../src/server/intake-conversation";

test("reports lead with actionable questions and link retained source revisions", () => {
  const text=reportMarkdown({dependencies:[{projectId:"project",status:"complete",report:{slug:"daily-project",revision:4},summary:{name:"Launch",summary:"One change",decisions:[{title:"Checkout",questions:["Which outcome accepts the preorder flow?"]}]}}],organizations:[{organization:{slug:"example",name:"Example"},status:"incomplete",reference:{slug:"daily-org",revision:2}}],completeness:{history:"limited"}});
  assert.ok(text.indexOf("Needs your attention")<text.indexOf("Project reports"));
  assert.match(text,/Which outcome accepts the preorder flow/);
  assert.match(text,/\.\/daily-project/);
  assert.match(text,/\/o\/example\/wiki-map\/p\/daily-org/);
  assert.match(text,/Historical coverage is limited/);
});

test("recorded deferred decisions are not regenerated as unanswered release questions", () => {
  const row={id:"request",revision:3,body:{input:{title:"Later work",projectId:"project"},routes:[],releaseFit:{disposition:"deferred",backlog:true,rationale:"After launch"}}} as any;
  assert.deepEqual(intakeQuestions(row).questions,[]);
  assert.match(reportMarkdown({decisions:[intakeQuestions(row)]}),/No pending intake questions were captured/);
});

test("identical decisions in different organizations retain provenance and nested truncation",()=>{
 const summary={name:"Launch",decisions:[{title:"Checkout",questions:["Which outcome?"]}],decisionsTruncated:true};
 const body=reportMarkdown({organizations:[{organizationSlug:"sunny",dependencies:[{summary}]},{organizationSlug:"keystone",dependencies:[{summary}]}]});
 assert.match(body,/sunny · Launch · Checkout/);
 assert.match(body,/keystone · Launch · Checkout/);
 assert.match(body,/Some intake decisions were omitted/);
});

test("personal goals distinguish definitions from measurements and do not invent standup",()=>{
 const body=reportMarkdown({goalContext:{complete:true,goals:[{title:"Launch",observation:{reason:"Measured progress remains unknown."},metrics:[{title:"Orders per week"}]}],standup:{reason:"No standup source contract is configured."}}});
 assert.match(body,/Orders per week/);
 assert.match(body,/Measured progress remains unknown/);
 assert.match(body,/no saved standup evidence/);
});

test("the personal overview contains project work and captured report links inside each organization",()=>{
 const body=reportMarkdown({organizations:[{organizationSlug:"sunny",status:"complete",reference:{slug:"org-note",revision:3},dependencies:[{projectId:"p",status:"complete",report:{slug:"project-note",revision:5},summary:{name:"Launch",summary:"One merged PR",repositoryEvidence:{complete:true,repositories:[{repository:"example/site",scope:"repository-wide",pullRequests:[{number:7,title:"Preorder checkout",url:"https://github.com/example/site/pull/7"}],unknowns:["Deployment was not verified."]}]}}}]}]});
 assert.match(body,/### sunny/);
 assert.match(body,/Preorder checkout/);
 assert.match(body,/\/o\/sunny\/wiki-map\/p\/project-note\?revision=5/);
 assert.match(body,/Deployment was not verified/);
 assert.doesNotMatch(reportMarkdown({repositoryEvidence:{repositories:[{pullRequests:[{number:1,title:"Unsafe",url:"javascript:alert(1)"}]}]}}),/javascript:/);
});


test("bounded repository omissions are visible rather than presented as no captured work",()=>{
 const markdown=reportMarkdown({repositoryEvidence:{complete:true,observedRepositoryCount:3,omittedRepositoryCount:1,repositories:[{repository:"example/one",pullRequests:[],directCommits:[],omittedPullRequestCount:4},{repository:"example/two",pullRequests:[],directCommits:[]}]}});
 assert.match(markdown,/1 additional repositories are outside this bounded preview/);
 assert.match(markdown,/4 additional merged pull request observations/);
 assert.doesNotMatch(markdown,/No merged pull requests or direct commits were captured|No GitHub repository is configured/);
});
