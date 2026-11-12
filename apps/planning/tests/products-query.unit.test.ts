import assert from "node:assert/strict";
import test from "node:test";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import {
  executeGraphQuery,
  memorySource,
  type TypeRow,
} from "@ai-outfitter/app-sdk/graph-graphql";
import { serveGraphql } from "@ai-outfitter/app-sdk/app-graphql";
import {
  readProductPage,
  productPageMarkdown,
  weeklyPeriod,
} from "../src/server/product-page-data";
import { graphqlSchema } from "../src/server/graphql";
import { regenerateProductReport, runProductReport } from "../src/server/product-report-workflow";
import { productsFocus } from "../src/agent-focus";
import { claimKey, conversationType, planningConversations, productsContext } from "../src/server/conversations";
import type { Thread } from "@ai-outfitter/app-sdk/threads";

function productFixture() {
  const nodeTypes = [
    "Organization",
    "Product",
    "ProductRevision",
    "Offering",
    "Project",
    "Goal",
    "WeeklyReport",
  ];
  const edgeTypes = [
    "developed_by",
    "offered_by",
    "packages_product",
    "part_of",
    "produces",
    "pursues",
    "revision_of",
  ];
  const types = [
    ...nodeTypes.map((name) => ({
      id: name,
      name,
      category: "node" as const,
      properties: [],
      archived: false,
    })),
    ...edgeTypes.map((name) => ({
      id: name,
      name,
      category: "edge" as const,
      properties: [],
      archived: false,
    })),
  ] as TypeRow[];
  const typeId = (name: string) =>
    types.find((type) => type.name === name)?.id ?? assert.fail(name);
  const row = (id: string, type: string, body?: unknown) => ({
    id,
    typeId: typeId(type),
    title: id,
    revision: 1,
    archived: false,
    body: JSON.stringify(body === undefined ? {} : body),
  });
  const nodes = [
    row("artera", "Organization"),
    row("foreign", "Organization"),
    row("product", "Product"),
    row("foreign-product", "Product"),
    row("project", "Project"),
    row("foreign-project", "Project"),
    row("goal", "Goal"),
    row("revision", "ProductRevision"),
    row("report", "WeeklyReport", {
      kind: "weekly_report",
      definition: "product-roadmap",
      organization_id: "artera",
      period_start: "2026-11-02",
      period_end: "2026-11-09",
      status: "open",
      narrative: "Draft for this week",
      proposed_priorities: ["Review priorities"],
    }),
    row("other-report", "WeeklyReport", null),
  ];
  const edge = (id: string, type: string, fromId: string, toId: string) => ({
    ...row(id, type),
    fromId,
    toId,
  });
  const edges = [
    edge("owner", "developed_by", "product", "artera"),
    edge("foreign-owner", "developed_by", "foreign-product", "foreign"),
    edge("produces", "produces", "project", "product"),
    edge("foreign-produces", "produces", "foreign-project", "product"),
    edge("project-owner", "part_of", "project", "artera"),
    edge("foreign-project-owner", "part_of", "foreign-project", "foreign"),
    edge("goal", "pursues", "project", "goal"),
    edge("revision", "revision_of", "revision", "product"),
    edge("unrelated-part-of", "part_of", "goal", "artera"),
  ];
  const seals: any[] = [];
  const calls: { operation: string; input: any }[] = [];
  Object.assign(nodes[0], { slug: "artera" });
  const source = memorySource({
    installationId: "wiki",
    types,
    nodes,
    edges,
  } as never);
  const host = {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one fixture dispatch models the host operations exercised by these integration-style tests.
    call: async (operation: string, input: any) => {
      calls.push({ operation, input });
      if (operation === "organization.context")
        return {
          organization: { id: "org-artera", slug: "artera", name: "Artera" },
        };
      if (operation === "entities.types")
        return ["graph-type", "graph-node", "graph-edge"].map((type) => ({
          type,
          installationId: "wiki",
          template: "wiki-map",
          collection: {
            "graph-type": "types",
            "graph-node": "nodes",
            "graph-edge": "edges",
          }[type],
          writable: true,
        }));
      if (operation === "entities.list") {
        if (input.type === "graph-type") {
          if (input.filter?.name === "WeeklyReportSeal")
            return seals.length
              ? [
                  {
                    ref: { id: "seal-type" },
                    attributes: {
                      name: "WeeklyReportSeal",
                      ontology: { version: 2, immutable: true },
                    },
                  },
                ]
              : [];
          return [
            {
              ref: { id: typeId("Organization") },
              attributes: { name: "Organization" },
            },
          ];
        }
        if (input.filter?.typeId === "seal-type") return seals;
        return [
          {
            ref: { id: "artera" },
            attributes: { properties: { organization_id: "org-artera" } },
          },
        ];
      }
      if (
        operation === "actions.call" &&
        input.action === "graph.graphql" &&
        !input.input?.query?.includes("WeeklyReportCapture")
      )
        return executeGraphQuery({ types, source, ...input.input });
      if (operation === "actions.list")
        return [
          { installationId: "governance", actions: [{ name: "graph.mutate" }] },
        ];
      if (
        operation === "actions.call" &&
        input.input?.query?.includes("WeeklyReportCapture")
      )
        return { data: { weeklyReportCapture: { planningDailyReports:{complete:true,errors:[],reports:[]} } } };
      if (operation === "inference.generate")
        throw new Error("Inference unavailable");
      throw new Error(`Unexpected ${operation}`);
    },
  } as any;
  const identity = {
    installationId: "planning",
    organizationId: "org-artera",
    userId: "editor",
    canEdit: true,
  } as any;
  return { host, identity, calls, seals, nodes };
}

test("Products includes the current weekly report, current products, revisions and organization-owned projects", async () => {
  const { host, identity } = productFixture();
  const page = await readProductPage(host, identity, "2026-11-07T12:00:00Z");
  assert.equal(page.periodStart, "2026-11-02");
  assert.deepEqual(
    page.products.map((row) => row.id),
    ["product"],
  );
  assert.deepEqual(
    page.products[0].revisions.map((row) => row.id),
    ["revision"],
  );
  assert.deepEqual(
    page.products[0].projects.map((row) => row.id),
    ["project"],
  );
  assert.deepEqual(
    page.products[0].projects[0].goals.map((row) => row.id),
    ["goal"],
  );
  assert.equal(page.report?.narrative, "Draft for this week");
  const md = productPageMarkdown(page);
  assert.match(md, /Draft for this week/);
  assert.match(md, /Review priorities/);
  assert.doesNotMatch(md, /foreign/);
  const next = await readProductPage(host, identity, "2026-11-09T00:00:00Z");
  assert.equal(next.report, null);
});
test("product page connections terminate after their singleton cursor", async () => {
  const { host, identity } = productFixture();
  const context = { identity, host: () => host, db: () => ({select: () => ({from: () => ({where: async () => []})})}) } as any;
  const query =
    'query($after:String){productPages(first:1,after:$after,at:"2026-11-07T12:00:00Z"){nodes{id} pageInfo{hasNextPage endCursor}}}';
  const first = (await serveGraphql({
    schema: graphqlSchema,
    query,
    context,
  })) as any;
  assert.equal(first.errors, undefined, JSON.stringify(first.errors));
  const next = (await serveGraphql({
    schema: graphqlSchema,
    query,
    variables: { after: first.data.productPages.pageInfo.endCursor },
    context,
  })) as any;
  assert.deepEqual(next.data.productPages.nodes, []);
});
test("weekly defaults handle Sunday, Monday and year transitions", () => {
  assert.deepEqual(weeklyPeriod("2027-01-03T23:59:59Z"), {
    start: "2026-12-28",
    end: "2027-01-04",
  });
  assert.deepEqual(weeklyPeriod("2027-01-04T00:00:00Z"), {
    start: "2027-01-04",
    end: "2027-01-11",
  });
  assert.throws(() => weeklyPeriod("invalid"));
});
test("failed inference cannot save or claim successful workflow collection", async () => {
  const { host, identity, calls } = productFixture();
  await assert.rejects(
    regenerateProductReport(host, identity, "run"),
    /Inference unavailable/,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.operation === "workflow.collect" ||
        call.input?.action === "graph.mutate",
    ),
    false,
  );
});

test("immutable seal preserves the displayed report after its working copy is edited or removed", async () => {
  const { host, identity, seals, nodes } = productFixture();
  const original = await readProductPage(host, identity, "2026-11-07");
  const sealedReport = {
    ...original.report,
    status: "sealed",
    narrative: "Sealed evidence",
    seal: { report_revision: 2, revision: 1, cutoff: "2026-11-09T00:00:00Z" },
  };
  seals.push({
    ref: { id: await stableGraphId("weekly-report-seal-v1", "wiki", "report") },
    attributes: {
      body: JSON.stringify({
        kind: "weekly_report_seal",
        report_id: "report",
        report: sealedReport,
      }),
    },
  });
  const wrapper = nodes.find((node) => node.id === "report")!;
  wrapper.body = JSON.stringify({
    ...original.report,
    narrative: "Tampered working copy",
  });
  const page = await readProductPage(host, identity, "2026-11-07");
  assert.equal(page.report?.narrative, "Sealed evidence");
  assert.equal(page.report?.revision, 2);
  assert.doesNotMatch(productPageMarkdown(page), /Tampered/);
  nodes.splice(nodes.indexOf(wrapper), 1);
  assert.equal(
    (await readProductPage(host, identity, "2026-11-07")).report?.narrative,
    "Sealed evidence",
  );
});


test("product conversations prepare canonical organization evidence and opt into member platform tools", async () => {
  const { host, identity } = productFixture();
  const db = {query: async () => { throw new Error("Product context must come from Wiki"); }, batch: async () => []};
  const provider = planningConversations(db, identity, undefined, host);
  const thread = {type: conversationType, context: {type: productsContext, id: productsFocus.id}} as Thread;
  const prepared = await provider.prepare({thread, submissionId: crypto.randomUUID(), entry: {metadata: {[claimKey]: {focus: productsFocus}}} as never, retry: false});
  assert.equal(prepared.platformTools, true);
  assert.match(JSON.stringify(prepared.context), /artera/);
  assert.doesNotMatch(JSON.stringify(prepared.context), /foreign-product/);
  assert.ok(prepared.tools?.some(tool => tool.name === "read_workflow_history"));
  assert.equal(prepared.tools?.some(tool => tool.name.startsWith("propose_")), false);
  for (const focus of [{...productsFocus, id: crypto.randomUUID()}, {...productsFocus, revision: 2}]) {
    await assert.rejects(provider.prepare({thread, submissionId: crypto.randomUUID(), entry: {metadata: {[claimKey]: {focus}}} as never, retry: false}), error => error instanceof Response && error.status === 400);
  }
  const foreign = planningConversations(db, {...identity, organizationId: "foreign"}, undefined, host);
  await assert.rejects(foreign.prepare({thread, submissionId: crypto.randomUUID(), entry: {} as never, retry: false}), error => error instanceof Response && error.status === 409);
  assert.throws(() => provider.scope({...thread, context: {type: productsContext, id: crypto.randomUUID()}}), error => error instanceof Response && error.status === 400);
});

test("roadmap generation retains incomplete daily dependencies and their captured context", async () => {
  const {host,identity,calls}=productFixture();
  const original=host.call;
  let capturedInput:any, generatedInput:any, saved:any;
  const daily={complete:false,errors:["Missing previous-day report"],reports:[]};
  host.call=async(operation:string,input:any)=>{
    if(operation==="actions.call" && input.input?.query?.includes("WeeklyReportCapture")){capturedInput=input;assert.equal(calls.some(call=>call.operation === "actions.call"),false,"capture precedes product membership read");return {data:{weeklyReportCapture:{planningDailyReports:daily}}};}
    if(operation==="inference.generate"){generatedInput=input;return {output:{narrative:"Evidence is incomplete",changes:[],proposedPriorities:[],openQuestions:[]}};}
    if(operation==="actions.call" && input.input?.query?.includes("UpdateWeeklyReport")){saved=input.input.variables.input;return {data:{updateWeeklyReport:{id:"report",revision:1,organizationId:"org-artera",updatedAt:"now"}}};}
    if(operation==="workflow.collect")return {};
    return original(operation,input);
  };
  await regenerateProductReport(host,identity,"daily-context-run");
  assert.ok(capturedInput.input.variables.start);
  assert.ok(capturedInput.input.variables.end);
  assert.equal(capturedInput.input.variables.timezone,"America/Chicago");
  assert.deepEqual(generatedInput.data.planningDailyReports,daily);
  assert.equal(saved.evidenceManifest.complete,false);
  assert.deepEqual(saved.evidenceManifest.errors,daily.errors);
  assert.deepEqual(JSON.parse(saved.sourceContext).planningDailyReports,daily);
});


test("historical weekly recovery captures and updates the selected past week after later task creation",async()=>{
 const {host,identity}=productFixture();
 const original=host.call;let captured:any,saved:any;
 host.call=async(operation:string,input:any)=>{
  if(operation==="workflow.read")return {run:{createdAt:Date.parse("2026-11-16T14:00:00Z")}};
  if(operation==="actions.call" && input.input?.query?.includes("WeeklyReportCapture")){captured=input.input.variables;return {data:{weeklyReportCapture:{planningDailyReports:{complete:true,errors:[],reports:[]}}}};}
  if(operation==="inference.generate")return {output:{narrative:"Recovered past week from captured source reports",changes:[],proposedPriorities:[],openQuestions:[]}};
  if(operation==="actions.call" && input.input?.query?.includes("UpdateWeeklyReport")){saved=input.input.variables.input;return {data:{updateWeeklyReport:{id:"report",revision:4,organizationId:"org-artera",updatedAt:"now"}}};}
  if(operation==="workflow.collect")return {};
  return original(operation,input);
 };
 await runProductReport(host,identity,{runId:"55555555-5555-4555-8555-555555555555",task:"product-roadmap-summary",inputs:{at:"2026-11-05"}});
 assert.deepEqual(captured,{start:"2026-11-02",end:"2026-11-09",timezone:"America/Chicago"});
 assert.equal(saved.periodStart,"2026-11-02");assert.equal(saved.periodEnd,"2026-11-09");
 assert.equal(saved.evidenceManifest.complete,true);
 assert.ok(saved.expectedRevision>0,"historical updates retain the read revision guard");
});


test("historical weekly regeneration cannot replace an already sealed report",async()=>{
 const {host,identity,seals,calls}=productFixture();
 const original=await readProductPage(host,identity,"2026-11-05");
 seals.push({ref:{id:await stableGraphId("weekly-report-seal-v1","wiki","report")},attributes:{body:JSON.stringify({kind:"weekly_report_seal",report_id:"report",report:{...original.report,status:"sealed",seal:{report_revision:2,revision:1,cutoff:"2026-11-09T00:00:00Z"}}})}});
 await assert.rejects(regenerateProductReport(host,identity,"sealed-recovery",new Date("2026-11-05T12:00:00Z")),error=>error instanceof Response && error.status===409);
 assert.equal(calls.some(call=>call.operation==="inference.generate" || call.operation==="actions.call" && call.input.action==="graph.mutate"),false);
});
