import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { wikiFixtureCall } from "@ai-outfitter/app-test/wiki-fixture";
import { appWorker } from "@ai-outfitter/app-test/worker";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { discoverySources, importSamples, previewDiscovery, saveDiscovery, sourceSample } from "../src/server/discovery";

const member = { userId: "river", organizationId: "", role: "owner" as const, owner: { kind: "user" as const, id: "river" } };
const who = { ...member, installationId: "forerunner", canEdit: true };
const person = "33000000-0000-4000-8000-000000000001";
const org = "33000000-0000-4000-8000-000000000002";
const email = "river@example.test";
const messages = [
  ["login", "Beacon sign-in", "River signed in successfully to Beacon as river@example.test."],
  ["provider", "Beacon developer", "Official North Labs product directory: North Labs develops Beacon.", "https://north.example.test/products/beacon"],
  ["invoice", "North Labs invoice NL-42", "River owes North Labs USD 42.50 under invoice NL-42 dated 2026-05-01, due 2026-05-20."],
  ["payment", "Payment receipt NL-42", "North Labs received USD 42.50 from River for invoice NL-42 on 2026-05-08."],
];
const invoice = "Invoice NL-42, USD 42.50, issued 2026-05-01, due 2026-05-20. Payment of USD 42.50 received 2026-05-08.";
const node = (key: string, name: string, type: string, summary: string, evidence: string[], existingId: string | null = null) =>
  ({ key, name, type, summary, evidence, existingId, certainty: "mentioned", confidence: 0.99 });
const edge = (from: string, type: string, to: string, reason: string, evidence: string[]) =>
  ({ from, type, to, reason, evidence, confidence: 0.99 });

test("personal discovery submits connected sign-in and settled invoice proposals to the installed Onto", async () => {
  const wiki = await appWorker("onto", appArtifact(new URL("../../onto", import.meta.url), "operational"));
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  const json = async (response: Response) => {
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  };
  const post = async (path: string, body: object) => json(await wiki.call(path, member, { method: "POST", body }));
  const action = (name: string, input: object) => post("/api/internal/actions/v1/call", { action: name, input });
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    await post("/api/internal/app-initialize", {});
    const { types } = await action("graph.read", {});
    const typeId = (name: string) => types.find((type: { name: string }) => type.name === name).id as string;
    await action("graph.apply", { requestKey: "setup", operations: [
      { ref: "$person", operation: "create", type: "graph-node", attributes: { id: person, typeId: typeId("Person"), title: "R. Arbor" } },
      { ref: "$vendor", operation: "create", type: "graph-node", attributes: { id: org, typeId: typeId("Organization"), title: "North Labs" } },
    ] });
    await post("/api/internal/identity/v1/link", { principalId: "river", holderId: person, kind: "human" });
    let reuseSignInCitation = false;
    let paymentRef = "e3";
    const host = { call: async (name: string, input: Record<string, unknown>) => {
      if (name === "identity.current") return { id: "river", name: "River", email };
      if (name === "identity.resolve") return post("/api/internal/identity/v1/resolve", { principalId: "river" });
      if (name === "snapshot") return { connections: [] };
      if (name === "workflow.start") return { id: input.id };
      if (name === "workflow.collect" || name === "session.append") return {};
      if (name === "inference.generate") {
        assert.match(JSON.stringify(input.data), /Verified Person: R\. Arbor/);
        assert.match(String(input.instructions), /Person → Product/);
        assert.match(JSON.stringify(input.data), /https:\/\/north.example.test\/products\/beacon/);
        return { output: { entities: [
          node("self", "River", "Person", "Signed in as River", ["operating-user", "e0"]),
          node("app", "Beacon", "Product", "North Labs product", ["e1"]),
          node("org", "North Labs", "Organization", "Developer and vendor", ["e1", "e2"], org),
          { ...node("bill", "North Labs invoice NL-42", "FinancialObligation", invoice, ["e2", "e3"]),
            matchedInvoice: { number: "NL-42", matchReference: null, amount: "42.50", paidAmount: "42.50", currency: "USD", invoiceDate: "2026-05-01", dueDate: "2026-05-20", paymentDate: "2026-05-08", invoiceRef: "e2", paymentRef } },
        ], relationships: [
          edge("self", "uses", "app", "Invalid personal endpoint", ["e0"]),
          edge("self", "signed_in_to", "app", "Verified personal sign-in", ["e0"]),
          edge("app", "developed_by", "org", "Provider identifies its product", [reuseSignInCitation ? "e0" : "e1"]),
          edge("self", "has_obligation", "bill", "Named on invoice and receipt", ["e2", "e3"]),
          edge("bill", "payable_to", "org", "Named vendor", ["e2"]),
        ] } };
      }
      const result = await wikiFixtureCall(wiki, { ...member, actor: { kind: "app", id: who.installationId } }, name, input);
      if (!result.ok) throw new Error(result.message);
      return result.value;
    } } as unknown as WorkflowHost<"interactive">;
    const sample = sourceSample.parse({ format: "outfitter-forerunner-sample-v1", provider: "gmail", account: email,
      collectionMethod: "agent-import", collectedAt: "2026-05-10T00:00:00Z", window: "May",
      records: messages.map(([id, title, text, url]) => ({ id, title, text, url, date: "2026-05-09" })) });
    await importSamples(db, who, { samples: [sample] });
    const sources = (await discoverySources(db, who, host)).sources.map(source => source.id);
    const preview = await previewDiscovery(db, who, host, { sources });
    assert.equal(preview.operations.length, 6);
    reuseSignInCitation = true;
    const unsupported = await previewDiscovery(db, who, host, { sources });
    assert.ok(unsupported.warnings.some(w => w.includes("Unresolved organization for Product “Beacon”")));
    assert.ok(!unsupported.operations.some(op => op.attributes.typeId === typeId("developed_by")));
    reuseSignInCitation = false;
    paymentRef = "e2";
    await assert.rejects(previewDiscovery(db, who, host, { sources }), (error: unknown) => error instanceof Response && error.status === 422);
    paymentRef = "e3";
    const receipt = await saveDiscovery(db, who, host, { previewId: preview.id, confirmDestination: true });
    assert.equal((receipt.receipt as { state: string }).state, "committed");
    const graph = await action("graph.read", {});
    const product = graph.nodes.find((n: { title: string }) => n.title === "Beacon").id;
    const bill = graph.nodes.find((n: { title: string }) => n.title === "North Labs invoice NL-42");
    assert.equal(bill.body, "Invoice NL-42: USD 42.50. Payment received: USD 42.50. Issued: 2026-05-01. Due: 2026-05-20. Payment date: 2026-05-08.");
    for (const [type, fromId, toId, evidence] of [
      ["signed_in_to", person, product, ["login"]], ["developed_by", product, org, ["provider"]],
      ["has_obligation", person, bill.id, ["invoice", "payment"]], ["payable_to", bill.id, org, ["invoice"]],
    ] as const) {
      assert.ok(graph.edges.some((e: { typeId: string; fromId: string; toId: string }) => e.typeId === typeId(type) && e.fromId === fromId && e.toId === toId), type);
      const op = preview.operations.find(o => o.attributes.typeId === typeId(type))!;
      assert.deepEqual(preview.proposals?.find(p => p.ref === op.ref)?.evidence.map(e => e.recordId), evidence.map(id => email + "/" + id));
    }
  } finally { client.close(); await wiki.dispose(); }
});

test("publication and registration reuse Google; a promotional email cannot establish customership or product use", async () => {
  const wiki = await appWorker("onto", appArtifact(new URL("../../onto", import.meta.url), "operational"));
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  const action = async (name: string, input: object) => {
    const response = await wiki.call("/api/internal/actions/v1/call", member, { method: "POST", body: { action: name, input } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    const initialized = await wiki.call("/api/internal/app-initialize", member, { method: "POST", body: {} });
    assert.equal(initialized.status, 200, await initialized.clone().text());
    const { types } = await action("graph.read", {});
    const typeId = (name: string) => types.find((t: { name: string }) => t.name === name).id;
    await action("graph.apply", { requestKey: "seed-google", operations: [
      { ref: "$google", operation: "create", type: "graph-node", attributes: { id: org, typeId: typeId("Organization"), title: "Google" } },
    ] });
    const base = { format: "outfitter-forerunner-sample-v1", collectionMethod: "agent-import", collectedAt: "2026-05-10T00:00:00Z", window: "May" };
    const sources = [
      sourceSample.parse({ ...base, provider: "gmail", account: email, records: [
        { id: "newsletter", title: "Google weekly news", text: "Delivered to River. Try Lumosity today!", date: "2026-05-07" },
        { id: "registration", title: "Google I/O", text: "River's registration is confirmed.", date: "2026-05-07" },
        { id: "purchase", title: "T3 Chat purchase", text: "River purchased T3 Chat from T3 Tools, Inc.", date: "2026-05-07" },
      ] }),
      sourceSample.parse({ ...base, provider: "web", account: "public", records: [
        ["newsletter", "Google publishes a weekly newsletter", "https://blog.google/newsletter-subscribe/"],
        ["event", "The Google I/O team organizes the event", "https://developers.googleblog.com/get-ready-for-google-io-2026/"],
        ["lumosity", "Lumos Labs created Lumosity", "https://www.lumosity.com/en/press/lumosity-research-platform-launch/"],
        ["t3", "T3 Tools, Inc. provides and operates T3 Chat", "https://t3.chat/terms-of-service"],
      ].map(([id, text, url]) => ({ id, title: text, text, url, date: "2026-11-24" })) }),
    ];
    await importSamples(db, who, { samples: sources });
    const host = { call: async (name: string, input: Record<string, unknown>) => {
      if (name === "identity.current") return { id: "river", name: "River", email };
      if (name === "identity.resolve") return null;
      if (name === "snapshot") return { connections: [] };
      if (name === "workflow.start") return { id: input.id };
      if (name === "workflow.collect" || name === "session.append") return {};
      if (name === "inference.generate") {
        const refs = (input.data as { evidence: { ref: string; excerpt: string }[] }).evidence;
        const cite = (snippet: string) => refs.filter(r => r.excerpt.includes(snippet)).map(r => r.ref);
        return { output: { entities: [
          node("person", "River", "Person", "Named recipient", cite("Delivered to River")),
          node("google", "Google", "Organization", "Publisher and organizer", cite("Google publishes"), org),
          node("newsletter", "Google weekly news", "Newsletter", "Weekly publication", cite("Google publishes")),
          node("event", "Google I/O", "HostedEvent", "Registered event", cite("registration is confirmed")),
          node("product", "Lumosity", "Product", "Mentioned in a promotion", cite("Try Lumosity")),
          node("labs", "Lumos Labs", "Organization", "Creator of Lumosity", cite("Lumos Labs created")),
          node("service", "T3 Chat", "Offering", "Provider's public service", cite("operates T3 Chat")),
          node("operator", "T3 Tools, Inc.", "Organization", "Service provider", cite("operates T3 Chat")),
        ], relationships: [
          { ...edge("person", "recipient_of", "newsletter", "Delivered", cite("Delivered to River")), observation: "delivery" },
          edge("newsletter", "published_by", "google", "Publisher", cite("Google publishes")),
          { ...edge("person", "registered_for", "event", "Registration confirmed", cite("registration is confirmed")), observation: "registration" },
          edge("event", "organized_by", "google", "Organizer", cite("team organizes")),
          edge("product", "developed_by", "labs", "Creator", cite("Lumos Labs created")),
          edge("service", "offered_by", "operator", "Operator", cite("operates T3 Chat")),
          { ...edge("person", "customer_of", "operator", "Named on purchase", cite("River purchased")), observation: "customer" },
          ...["user_of", "signed_in_to", "customer_of"].map(type => ({
            ...edge("person", type, type === "customer_of" ? "labs" : "product", "Promotion only", cite("Try Lumosity")),
            observation: "delivery",
          })),
        ] } };
      }
      const result = await wikiFixtureCall(wiki, member, name, input);
      if (!result.ok) throw new Error(result.message);
      return result.value;
    } } as unknown as WorkflowHost<"interactive">;
    const selected = await discoverySources(db, who, host);
    const preview = await previewDiscovery(db, who, host, { sources: selected.sources.map(s => s.id) });
    const edges = preview.operations.filter(op => op.type === "graph-edge");
    assert.deepEqual(edges.map(op => op.attributes.typeId), ["recipient_of", "published_by", "registered_for", "organized_by", "developed_by", "offered_by", "customer_of"].map(typeId));
    assert.equal(edges.filter(op => op.attributes.toId === org).length, 2);
    assert.ok(!preview.operations.some(op => op.attributes.title === "Google"));
    assert.equal(preview.warnings.filter(w => w.includes("source documents delivery")).length, 3);
    assert.ok(!preview.warnings.some(w => w.includes("Unresolved organization")));
  } finally { client.close(); await wiki.dispose(); }
});
