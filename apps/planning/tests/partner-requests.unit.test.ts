import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, type InValue } from "@libsql/client";
import { mutateAction, graphqlAction } from "@ai-outfitter/app-sdk/app-graphql";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { documents } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";
import type { PlanningContext } from "../src/server/intake";
import { designPartnerQuery, designPartnersIn, requestChangesDocument } from "../src/server/partner-requests";
// Read the published discovery artifact as a contract fixture, not app implementation.
const foundryDocuments = JSON.parse(readFileSync(new URL("../../software-foundry/graph/documents.json", import.meta.url), "utf8"));

// Design partners are customers with a flag in this organization's graph. A partner's member
// runs SubmitPartnerRequest from its own organization (role external, no workflow host); editors
// refresh the partners, accept (Foundry's RequestChanges files it as an issue) or reject.
type Result = { data: Record<string, Record<string, unknown> | null> | null; errors?: { message: string; extensions?: Record<string, unknown> }[] };
// As the actions route mounts it.
const mutate = mutateAction(graphqlSchema, { canInvoke: () => true, external: true });
const query = graphqlAction(graphqlSchema);
const run = (context: PlanningContext, name: keyof typeof documents, variables: Record<string, unknown>) => {
  const kind = (documents[name].document.definitions[0] as { operation: string }).operation;
  const input = { query: documentText(documents[name].document), operationName: name, variables };
  return (kind === "mutation" ? mutate : query).invoke(context, input) as Promise<Result>;
};
const first = (result: Result) => result.errors?.[0]?.message ?? "no error";
const field = <T = Record<string, unknown>>(result: Result, name: string): T => {
  assert.equal(result.errors, undefined, first(result));
  return result.data?.[name] as T;
};
const invalid = (result: Result) => assert.equal(result.errors?.[0]?.extensions?.code, "BAD_USER_INPUT", first(result));
const bug = { stepsToReproduce: ["Open a project", "Export"], expected: "A CSV", actual: "Nothing" };
const refused = (result: Result, status: number, message?: RegExp) => {
  assert.deepEqual(result.errors?.[0]?.extensions, { code: "REFUSED", status }, first(result));
  if (message) assert.match(first(result), message);
};

const org = (id: string, title: string, organizationId?: string, extra: Record<string, unknown> = {}) =>
  ({ id, typeId: "t-org", title, revision: 1, properties: organizationId ? { organization_id: organizationId } : {}, ...extra });
const customer = (id: string, fromId: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id, typeId: "t-customer", fromId, toId: "n-us", revision: 1, properties, ...extra });
const wiki = (nodes: unknown[], edges: unknown[]) => ({
  installationId: "onto",
  types: [
    { id: "t-org", category: "node", name: "Organization", title: "Organizations", properties: [], revision: 1 },
    { id: "t-product", category: "node", name: "Product", title: "Products", properties: [], revision: 1 },
    { id: "t-customer", category: "edge", name: "customer_of", title: "customer of", properties: [], revision: 1 },
  ],
  nodes: [org("n-us", "Outfitter", "us"), ...nodes],
  edges,
});
const now = Date.parse("2026-11-04T00:00:00Z");
const partners = async (nodes: unknown[], edges: unknown[]) =>
  designPartnersIn(await queryGraph(wiki(nodes, edges) as never, designPartnerQuery() as never), "us", now);

test("a design partner is a customer whose customer_of link to us has design_partner set", async () => {
  assert.deepEqual(await partners(
    [org("n-a", "Artera", "artera"), org("n-s", "Sunny", "sunny"), org("n-x", "Unflagged", "unflagged")],
    [customer("e1", "n-a", { design_partner: true }), customer("e2", "n-s", { design_partner: true, status: "documented" }), customer("e3", "n-x", { status: "documented" })],
  ), [{ organizationId: "artera", name: "Artera" }, { organizationId: "sunny", name: "Sunny" }]);
  // Only current records bound to one organization count; names are never matched.
  const flagged = { design_partner: true };
  assert.deepEqual(await partners([org("n-a", "Artera", "artera"), org("n-b", "Artera 2", "artera")], [customer("e1", "n-a", flagged)]), []);
  assert.deepEqual(await partners([org("n-a", "Artera")], [customer("e1", "n-a", flagged)]), []);
  assert.deepEqual(await partners([org("n-a", "Artera", "artera")], [customer("e1", "n-a", { ...flagged, status: "retired" })]), []);
  assert.deepEqual(await partners([org("n-a", "Artera", "artera")], [customer("e1", "n-a", flagged, { archived: true })]), []);
  assert.deepEqual(await partners([org("n-a", "Artera", "artera")], [customer("e1", "n-a", flagged, { validity: { from: null, to: "2026-11-01T00:00:00Z" } })]), []);
  assert.deepEqual(await partners([org("n-a", "Artera", "artera")], [customer("e1", "n-a", { design_partner: "true" })]), []);
});

/** Planning's database on in-memory SQLite, an Onto graph where Artera is flagged and Sunny is not, and a
 * Foundry that records RequestChanges calls. */
async function fixture() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const flag = { artera: true };
  const graph = () => wiki(
    [org("n-a", "Artera", "artera"), org("n-s", "Sunny", "sunny"), { id: "p-workshop", typeId: "t-product", title: "Workshop", revision: 4, properties: {} }],
    [customer("e1", "n-a", { design_partner: flag.artera }), customer("e2", "n-s", { status: "documented" })],
  );
  const recorded: Record<string, unknown>[] = [];
  const foundry = { refuse: false };
  const host = {
    call: async (name: string, raw: unknown) => {
      const input = raw as Record<string, unknown>;
      if (name === "entities.types") return input.template === "onto" ? ["graph-type", "graph-node", "graph-edge"].map((type) => ({ type, installationId: "onto", writable: true })) : [];
      if (name === "actions.list") return input.template === "software-foundry" ? [{ installationId: "foundry", actions: [{ name: "graph.mutate" }] }] : [];
      if (name === "actions.call" && input.action === "graph.query") return queryGraph(graph() as never, input.input as never);
      if (name === "actions.call" && input.action === "graph.mutate" && input.installationId === "foundry") {
        const call = input.input as { query: string; operationName: string; variables: { input: { items: { key: string; action: string; input: Record<string, unknown> }[] } } };
        assert.equal(call.query, requestChangesDocument);
        assert.equal(call.operationName, "RequestChanges");
        const [item] = call.variables.input.items;
        assert.equal(item.action, "submit");
        if (foundry.refuse) return { data: { requestChanges: { items: [{ key: item.key, status: "uncertain", result: null, error: { code: "EXECUTION_UNCERTAIN", message: "Repository not approved" } }], instructions: [] } } };
        recorded.push(item.input);
        const result = { id: item.input.requestId, kind: item.input.kind, issue: { number: 7, url: "https://github.com/ai-outfitter/webapp/issues/7", created: true }, run: { id: "run-1", status: "running" } };
        return { data: { requestChanges: { items: [{ key: item.key, status: "complete", result, error: null }], instructions: [] } } };
      }
      throw new Error(`Unexpected ${name}: ${JSON.stringify(input)}`);
    },
  };
  const store = {
    query: async (s: { sql: string; params?: unknown[] }) => (await client.execute({ sql: s.sql, args: (s.params ?? []) as InValue[] })).rows as Record<string, unknown>[],
    batch: async (ss: { sql: string; params?: unknown[] }[]) => client.batch(ss.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InValue[] })), "write"),
  };
  const noHost = { call: async () => { throw new Error("A call from another organization has no workflow host"); } };
  const base = { members: () => [], db: () => db, store: () => store };
  const editor = (userId = "nicholas"): PlanningContext => ({
    identity: { userId, organizationId: "us", owner: { kind: "organization", id: "us" }, installationId: "planning", role: "owner", access: "admin", canEdit: true },
    actor: { kind: "member", id: userId }, originActor: { kind: "member", id: userId }, host: () => host, ...base,
  }) as unknown as PlanningContext;
  const reader = (): PlanningContext => ({ ...editor("pat"), identity: { ...editor().identity, userId: "pat", role: "member", access: "read", canEdit: false } }) as unknown as PlanningContext;
  const external = (callerOrganizationId: string, userId = "shen"): PlanningContext => ({
    identity: { userId, organizationId: "us", owner: { kind: "organization", id: "us" }, installationId: "planning", role: "external", access: "read", canEdit: false, callerOrganizationId },
    actor: { kind: "member", id: userId }, originActor: { kind: "member", id: userId }, host: () => noHost, ...base,
  }) as unknown as PlanningContext;
  return { close: () => client.close(), editor, reader, external, flag, recorded, foundry };
}

const request = { requestId: "6F1C2C4E-1D7B-4F4E-9D3C-3A0F6F7F2B10", kind: "feature", title: "Export a bill of materials", problem: "We copy parts lists by hand.", acceptanceCriteria: [{ id: "csv", text: "A CSV lists every part" }], productId: "p-workshop" };
type View = { id: string; requestId: string; revision: number; status: string; kind: string; reason: string | null; foundryRequest: { requestId: string; issue: { url: string } } | null; partner: { organizationId: string } };

test("Planning runs the RequestChanges document Software Foundry publishes, as the platform requires", () => {
  const published = (foundryDocuments as { name: string; query: string }[]).find(row => row.name === "RequestChanges");
  assert.equal(published?.query, requestChangesDocument);
});

test("a design partner files from its own organization; editors accept through Foundry or reject", async () => {
  const f = await fixture();
  try {
    const artera = f.external("artera");
    // Until an editor refreshes the list from the Wiki, nobody is a design partner.
    refused(await run(artera, "SubmitPartnerRequest", { input: request }), 403, /public repository/);
    refused(await run(f.reader(), "RefreshDesignPartners", { input: {} }), 403);
    assert.deepEqual(field(await run(f.editor(), "RefreshDesignPartners", { input: {} }), "refreshDesignPartners"), { designPartners: [{ organizationId: "artera", name: "Artera" }] });

    const filed = field<View>(await run(artera, "SubmitPartnerRequest", { input: request }), "submitPartnerRequest");
    assert.deepEqual([filed.status, filed.requestId, filed.partner.organizationId], ["proposed", request.requestId.toLowerCase(), "artera"]);
    // A replay returns the request with its status; changed content conflicts; another partner's ID space is its own.
    assert.equal(field<View>(await run(artera, "SubmitPartnerRequest", { input: request }), "submitPartnerRequest").id, filed.id);
    refused(await run(artera, "SubmitPartnerRequest", { input: { ...request, title: "Something else" } }), 409);
    // Customers without the flag, and members of this organization, are refused.
    refused(await run(f.external("sunny"), "SubmitPartnerRequest", { input: request }), 403, /public repository/);
    refused(await run(f.editor(), "SubmitPartnerRequest", { input: request }), 403, /RequestChanges/);
    // A partner reaches nothing else: no other mutation, no read.
    refused(await run(artera, "RefreshDesignPartners", { input: {} }), 403, /other organizations/);
    refused(await run(artera, "RejectPartnerRequest", { input: { id: filed.id, revision: 1, reason: "no" } }), 403, /other organizations/);
    await assert.rejects(run(artera, "PartnerRequests", {}), (error: unknown) => error instanceof Response && error.status === 403);

    // A bug needs bug details; only a bug carries them.
    invalid(await run(artera, "SubmitPartnerRequest", { input: { ...request, requestId: crypto.randomUUID(), kind: "bug" } }));
    invalid(await run(artera, "SubmitPartnerRequest", { input: { ...request, requestId: crypto.randomUUID(), bug } }));

    // Editors list and accept: the graph is read again, Foundry files it as the editor with the partner named.
    refused(await run(f.reader(), "PartnerRequests", {}), 403);
    const listed = field<View[]>(await run(f.editor(), "PartnerRequests", { status: "proposed" }), "partnerRequests");
    assert.deepEqual(listed.map(row => row.id), [filed.id]);
    const accept = { id: filed.id, revision: filed.revision, target: { repository: "ai-outfitter/webapp" } };
    f.foundry.refuse = true;
    refused(await run(f.editor(), "AcceptPartnerRequest", { input: accept }), 422, /not approved/);
    f.foundry.refuse = false;
    const accepted = field<View>(await run(f.editor(), "AcceptPartnerRequest", { input: accept }), "acceptPartnerRequest");
    assert.deepEqual([accepted.status, accepted.revision, accepted.foundryRequest?.requestId, accepted.foundryRequest?.issue.url], ["accepted", 2, filed.id, "https://github.com/ai-outfitter/webapp/issues/7"]);
    const sent = f.recorded[0];
    assert.deepEqual(Object.keys(sent).sort(), ["acceptanceCriteria", "context", "kind", "problem", "requestId", "target", "title"]);
    assert.equal(sent.requestId, filed.id);
    assert.equal(sent.kind, "feature");
    assert.match(String(sent.problem), /^Filed by design partner Artera \(organization artera, user shen\) for Workshop\.\n\nWe copy parts lists by hand\.$/);
    assert.deepEqual(sent.acceptanceCriteria, request.acceptanceCriteria);
    assert.deepEqual(sent.context, [{ installationId: "onto", type: "graph-node", id: "p-workshop", title: "Workshop" }]);
    assert.deepEqual(sent.target, { repository: "ai-outfitter/webapp" });
    // The partner reads the outcome by replaying its request.
    assert.equal(field<View>(await run(artera, "SubmitPartnerRequest", { input: request }), "submitPartnerRequest").status, "accepted");
    refused(await run(f.editor(), "AcceptPartnerRequest", { input: { ...accept, revision: 2 } }), 409, /already accepted/);

    // A bug goes to Foundry with its details.
    const bugReport = field<View>(await run(artera, "SubmitPartnerRequest", { input: { ...request, requestId: crypto.randomUUID(), kind: "bug", bug } }), "submitPartnerRequest");
    field(await run(f.editor(), "AcceptPartnerRequest", { input: { id: bugReport.id, revision: 1, target: { project: "hardware" } } }), "acceptPartnerRequest");
    assert.deepEqual([f.recorded[1].kind, f.recorded[1].bug, f.recorded[1].target], ["bug", bug, { project: "hardware" }]);

    // Reject: a reason, nothing filed. Once the graph drops the flag, accepting is refused and filing stops after a refresh.
    const second = field<View>(await run(artera, "SubmitPartnerRequest", { input: { ...request, requestId: crypto.randomUUID() } }), "submitPartnerRequest");
    refused(await run(f.editor(), "RejectPartnerRequest", { input: { id: second.id, revision: 9, reason: "Later" } }), 409);
    const rejected = field<View>(await run(f.editor(), "RejectPartnerRequest", { input: { id: second.id, revision: 1, reason: "Not this quarter" } }), "rejectPartnerRequest");
    assert.deepEqual([rejected.status, rejected.reason], ["rejected", "Not this quarter"]);
    const third = field<View>(await run(artera, "SubmitPartnerRequest", { input: { ...request, requestId: crypto.randomUUID() } }), "submitPartnerRequest");
    f.flag.artera = false;
    refused(await run(f.editor(), "AcceptPartnerRequest", { input: { id: third.id, revision: 1, target: { repository: "ai-outfitter/webapp" } } }), 403, /no longer/);
    refused(await run(artera, "SubmitPartnerRequest", { input: { ...request, requestId: crypto.randomUUID() } }), 403, /public repository/);
    assert.equal(f.recorded.length, 2);
  } finally {
    f.close();
  }
});
