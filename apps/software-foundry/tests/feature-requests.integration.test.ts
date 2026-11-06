import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { wikiFixtureCall } from "@ai-outfitter/app-test/wiki-fixture";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { documents } from "../src/server/documents";
import { featureRequestType } from "../src/server/feature-requests";

function workflowReply(operation: string, input: Record<string, unknown>, taskStarts: Record<string, unknown>[], collected: Record<string, unknown>[]) {
  const ok = (value: unknown) => ({ ok: true as const, value });
        if(operation === "task.start") {taskStarts.push(input);return ok({id:input.id,task:input.task,created:taskStarts.length===1});}
        if(operation === "inference.generate")return ok({output:{summary:"Export the selected records.",questions:[],acceptanceCriteria:["Only selected records appear."]}});
        if(operation === "workflow.collect"){collected.push(input);return ok({run:String(input.runId),steps:{}});}
  return undefined;
}

function isGovernanceCall(operation: string, input: Record<string, unknown>) {
  return operation === "actions.call" && input.installationId === "governance";
}
function governanceReply(authority: Record<string, unknown> | null) {
  return authority ? {ok: true as const, value: authority} : {ok: false as const, status: 403, message: "A current organizational role assignment is required"};
}

// RequestFeature through graph.mutate, as graph_mutate runs it: the Wiki records one
// FeatureRequest linked to the organization, the verified submitter, its Governance role and
// related nodes. Refusals write nothing, and nothing reaches GitHub or a workflow.
// Real Wiki and Foundry workers; Governance and GitHub are doubles.
test("RequestFeature records an attributed FeatureRequest in the Wiki, once per requestId", { skip: !process.env.OUTFITTER_WIKI_PACKAGE && "Set OUTFITTER_WIKI_PACKAGE to a built Wiki operational package" }, async () => {
  const owner = { userId: "owner", organizationId: "org", role: "owner" };
  const wiki = await appWorker("wiki-map", process.env.OUTFITTER_WIKI_PACKAGE!);
  const ok = (value: unknown) => ({ ok: true as const, value });
  let authority: Record<string, unknown> | null = null;
  let writes = 0;
  const taskStarts: Record<string,unknown>[]=[];
  const collected: Record<string,unknown>[]=[];
  const operations: string[] = [];
  const fixed: Record<string, unknown> = {
    snapshot: {
      installation: { id: "foundry", activeHash: "hash", hostname: "foundry.synthetic.localhost", workflows: [] },
      bindings: [], subscriptions: [],
      connections: [{ id: "github", provider: "github", revision: "r", owner: "organization", operations: ["issues.read"], repositories: ["acme/app"] }],
    },
    "repository.request": { id: 1, full_name: "acme/app" },
    "organization.context": { organization: { id: "org", slug: "synthetic", name: "Synthetic", instructions: "", operational: true } },
    "actions.list": [{ installationId: "governance", actions: [{ name: "governance.submission-authority", description: "Current evidence", access: "read", permitted: true, input: {}, output: {} }] }],
  };
  const app = await appWorker("software-foundry", appArtifact(new URL("..", import.meta.url), "operational"), "feature-request-foundry", {
    workflowHost: () => ({
      async call(operation, raw) {
        const input = raw as Record<string, unknown>;
        operations.push(operation);
        const workflow = workflowReply(operation, input, taskStarts, collected);
        if (workflow) return workflow;
        if (Object.hasOwn(fixed, operation)) return ok(fixed[operation]);
        if (isGovernanceCall(operation, input)) return governanceReply(authority);
        if (operation === "entities.create" || operation === "entities.update") writes++;
        return wikiFixtureCall(wiki, owner, operation, raw);
      },
    }),
  });
  const scope = { organizationId: "org", installationId: app.installationId, userId: "owner", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 600000 };
  const entity = async (operation: string, input: object) => {
    const response = await wiki.call(`/api/internal/entities/v1/${operation}`, owner, { method: "POST", body: input });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as EntityRecord;
  };
  type Recorded = { ref: EntityRecord["ref"]; revision: number; repository: string; submittedAt: string; created: boolean };
  const send = async (input: object, identity = owner) => {
    const response = await app.call("/api/internal/actions/v1/call", identity, {
      method: "POST", workflowHost: scope,
      body: { action: "graph.mutate", input: { query: documentText(documents.RequestFeature.document), operationName: "RequestFeature", variables: { input } } },
    });
    if (response.status !== 200) return { status: response.status };
    const { data, errors } = (await response.json()) as { data: { requestFeature: Recorded } | null; errors?: { message: string; extensions?: { status?: number } }[] };
    return { status: errors?.length ? (errors[0].extensions?.status ?? 400) : 200, recorded: data?.requestFeature, error: errors?.[0]?.message };
  };
  const recorded = async (input: object) => {
    const { recorded, error } = await send(input);
    assert.ok(recorded, error ?? "No result");
    return recorded;
  };
  try {
    const wikiInit = await wiki.call("/api/internal/app-initialize", owner, { method: "POST", body: {} });
    assert.equal(wikiInit.status, 200, await wikiInit.clone().text());
    const types: EntityRecord[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = (await (await wiki.call("/api/internal/entities/v1/list", owner, { method: "POST", body: { type: "graph-type", limit: 100, offset } })).json()) as EntityRecord[];
      types.push(...page);
      if (page.length < 100) break;
    }
    const type = (name: string) => {
      const row = types.find((one) => one.attributes.name === name);
      assert.ok(row, name);
      return row;
    };
    const organizationType = type("Organization");
    const properties = organizationType.attributes.properties as { name: string }[];
    if (!properties.some((property) => property.name === "organization_id"))
      await entity("update", { type: "graph-type", id: organizationType.ref.id, revision: organizationType.revision, attributes: {
        properties: [...properties, { name: "organization_id", type: "string", required: false, description: "Exact authenticated organization ID" }],
      } });
    const node = (name: string, title: string, extra: object = {}) =>
      entity("create", { type: "graph-node", attributes: { typeId: type(name).ref.id, title, ...extra } });
    const ref = (row: EntityRecord) => ({ ref: row.ref, revision: row.revision });
    const org = await node("Organization", "Synthetic", { properties: { organization_id: "org" } });
    const person = await node("Person", "Synthetic submitter");
    const assignment = await node("RoleAssignment", "Synthetic assignment");
    const technology = await node("Technology", "Synthetic technology");
    const granted = { organizationId: "org", organization: ref(org), principalId: "owner", kind: "human", submitter: ref(person), assignments: [ref(assignment)] };

    const request = (extra: object = {}) => ({
      requestId: crypto.randomUUID(), target: { repository: "acme/app" }, title: "Export a filtered report",
      problem: "Teams rebuild the same report by hand.", requestedChange: "Export the current selection.",
      acceptanceCriteria: ["The export contains only the selected records."], relatedNodes: [ref(technology)], ...extra,
    });
    const featureRequests = async () => (await wiki.database.prepare("SELECT count(*) AS n FROM graph_nodes WHERE typeId=?").bind(featureRequestType).first()) as { n: number };

    // Refused callers and bad input write nothing.
    const before = writes;
    assert.equal((await send(request(), { ...owner, role: "member" })).status, 403, "a read-only member");
    assert.equal((await send(request())).status, 403, "no Governance role");
    authority = { ...granted, principalId: "someone-else" };
    assert.equal((await send(request())).status, 403, "authority for another principal");
    authority = granted;
    assert.equal((await send(request({ problem: " " }))).status, 400);
    assert.equal((await send(request({ relatedNodes: [{ ...ref(technology), revision: technology.revision + 1 }] }))).status, 409, "a stale related node");
    assert.equal((await send(request({ relatedNodes: [{ ref: { ...technology.ref, installationId: "foreign" }, revision: 1 }] }))).status, 409, "a foreign related node");
    assert.equal((await send(request({ relatedNodes: [ref(technology), ref(technology)] }))).status, 409, "duplicate related nodes");
    assert.ok((await send(request({ target: { repository: "acme/other" } }))).status >= 400, "an ungranted repository");
    assert.equal((await send(request({ target: { project: crypto.randomUUID() } }))).status, 409, "an unknown project");
    assert.equal((await send(request({ problem: "x".repeat(16000), requestedChange: "y".repeat(16000), acceptanceCriteria: Array(50).fill("z".repeat(2000)) }))).status, 413);
    assert.equal(writes, before);
    assert.deepEqual(await featureRequests(), { n: 0 });

    // An editor with a Governance role records the request.
    const input = request();
    const first = await recorded(input);
    assert.equal(first.created, true);
    assert.equal(first.repository, "acme/app");
    const stored = await entity("get", { type: "graph-node", id: first.ref.id });
    assert.equal(stored.attributes.typeId, featureRequestType);
    assert.equal(stored.title, input.title);
    const body = JSON.parse(String(stored.attributes.body));
    assert.deepEqual([body.status, body.principalId, body.kind, body.organizationSlug], ["awaiting_configuration", "owner", "human", "synthetic"]);
    assert.deepEqual(body.target, { repository: "acme/app", repositoryId: 1, project: null });
    assert.deepEqual([body.organization, body.submitter, body.assignments], [ref(org), ref(person), [ref(assignment)]]);
    assert.equal(body.brief.problem, input.problem);
    const links = await wiki.database.prepare("SELECT toId FROM graph_edges WHERE fromId=?").bind(first.ref.id).all();
    assert.deepEqual(new Set(links.results.map((row) => row.toId)), new Set([org, person, assignment, technology].map((row) => row.ref.id)));
    assert.equal(links.results.length, 4);

    // A retry with the same requestId (any case) finds it; different content under it conflicts.
    const again = await recorded({ ...input, requestId: input.requestId.toUpperCase() });
    assert.deepEqual(again, { ...first, created: false });
    assert.equal((await send({ ...input, title: "Changed" })).status, 409);
    assert.deepEqual(await featureRequests(), { n: 1 });
    // Recording opens no issue and starts no work.
    assert.ok(!operations.some((operation) => /connector.execute|workflow\./.test(operation)), operations.join());

    const requestId=crypto.randomUUID();
    const submitted=request({requestId,kind:"bug"});
    const submitResponse=await app.call("/api/internal/actions/v1/call",owner,{method:"POST",workflowHost:scope,body:{action:"graph.mutate",input:{query:documentText(documents.RequestChanges.document),operationName:"RequestChanges",variables:{input:{items:[{key:requestId,action:"submit",input:submitted}]}}}}});
    const submission=await submitResponse.json() as any;
    assert.equal(submission.data.requestChanges.items[0].status,"pending");
    assert.equal(taskStarts[0].task,"foundry-request-intake");
    await entity("update", {type:"graph-node",id:technology.ref.id,revision:technology.revision,attributes:{title:"Updated after submission"}});
    const phase=await app.call("/api/internal/workflow-host/v1",owner,{method:"POST",workflowHost:scope,body:{phase:"interactive",input:{runId:requestId,task:"foundry-request-intake",inputs:{requestId}}}});
    assert.equal(phase.status,200,`${await phase.clone().text()} ${operations.join(", ")}`);
    assert.equal(collected.at(-1)?.slot,"triage.outputs.result");
    assert.equal((collected.at(-1)?.value as any)?.kind,"bug");
    assert.equal((collected.at(-1)?.value as any)?.status,"awaiting_review");
  } finally {
    await app.dispose();
    await wiki.dispose();
  }
});
