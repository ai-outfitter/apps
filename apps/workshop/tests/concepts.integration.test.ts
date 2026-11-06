import assert from "node:assert/strict";
import test from "node:test";
import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHostResult, WorkflowHostScope, WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import type { Project } from "../src/lib/project";

// The built operational worker: concept images in its own bucket, references in
// the project, and publishing through a workflow host double that answers the
// Wiki operations the app calls and records the graph.apply it receives.
const member = { userId: "member", organizationId: "org", role: "member" };
const installationId = "concepts";
const wiki = "wiki-1";
const revisionId = "11111111-1111-4111-8111-111111111111";
const designConceptId = "7b000000-0000-4000-8000-000000000011";
const artifact = () => appArtifact(new URL("..", import.meta.url), "operational");
const projects = "/api/apps/workshop/projects";
// A 1x1 PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function wikiHost() {
  const applied: Record<string, unknown>[] = [];
  const ok = (value: unknown): WorkflowHostResult => ({ ok: true, value });
  const denied = (status: number, message: string): WorkflowHostResult => ({ ok: false, status, message });
  const record = (id: string, title: string, revision: number) => ({ ref: { installationId: wiki, type: "graph-node", id }, revision, title, attributes: { id, title }, references: [] });
  const provider = (type: string) => ({ installationId: wiki, template: "wiki-map", hostname: "wiki.org.example", type, title: type, description: "", schema: {}, writable: true });
  function answer(operation: string, input: Record<string, unknown>): WorkflowHostResult {
    switch (operation) {
      case "entities.types":
        return ok(["graph-type", "graph-node", "graph-edge"].map(provider));
      case "entities.get":
        if (input.id === revisionId) return ok(record(revisionId, "SNSP-1 Indoor rev A", 4));
        if (input.id === designConceptId) return ok(record(designConceptId, "Design concept", 1));
        return denied(404, "Not found");
      case "entities.list":
        return ok([{ ref: { installationId: wiki, type: "graph-type", id: "7b000000-0000-4000-8000-000000000003" }, revision: 1, title: "evidence for", attributes: { name: "evidence_for", archived: false }, references: [] }]);
      case "actions.call":
        applied.push(input);
        return ok({ $document: { id: "22222222-2222-4222-8222-222222222222", revision: 1 } });
      default:
        return denied(403, `Operation not used by this app: ${operation}`);
    }
  }
  return {
    applied,
    host: (_scope: WorkflowHostScope): WorkflowHostStub => ({ async call(operation, input) { return answer(operation, input as Record<string, unknown>); } }),
  };
}
const scope = (method: string): WorkflowHostScope => ({
  organizationId: "org", installationId, userId: member.userId, packageHash: "hash", phase: "interactive", expiresAt: Date.now() + 60_000,
  ...(method === "GET" ? {} : { initiation: "member" as const }),
});

test("concepts: images go to the bucket, the project keeps references, and publishing writes one Wiki Document", async () => {
  const double = wikiHost();
  const app = await appWorker("workshop", artifact(), installationId, { workflowHost: double.host });
  try {
    const identity = identityHeaderValues({ ...member, installationId });
    /** An image upload as the browser or the platform's generator sends it. */
    const upload = (path: string, body: Uint8Array, contentType = "image/png") =>
      app.dispatch("", new Request(`${app.origin}${path}`, { method: "POST", headers: { ...identity, "Content-Type": contentType }, body: new Blob([Uint8Array.from(body)]) }));
    const created = await app.call(projects, member, { method: "POST", body: { example: "holder" } });
    assert.equal(created.status, 201);
    const project = (await created.json()) as Project;
    assert.deepEqual(project.concepts, []);
    const concepts = `${projects}/${project.id}/concepts`;

    // An upload names the project revision it applies to; the saved project is the next revision.
    const query = new URLSearchParams({ revision: "1", model: "upload", prompt: "A sensor in a plant pot", caption: "In the pot" });
    const added = await upload(`${concepts}?${query}`, png);
    assert.equal(added.status, 201, await added.clone().text());
    const withConcept = (await added.json()) as Project;
    assert.equal(withConcept.revision, 2);
    assert.equal(withConcept.concepts.length, 1);
    const [concept] = withConcept.concepts;
    assert.deepEqual([concept.model, concept.prompt, concept.caption, concept.contentType], ["upload", "A sensor in a plant pot", "In the pot", "image/png"]);
    assert.equal(concept.key, `${project.id}/${concept.id}.png`);
    assert.match(concept.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(withConcept).includes(png.toString("base64")), "the project holds no image bytes");
    const bucket = await app.bucket("main");
    const stored = await bucket.get(`concepts/${concept.key}`);
    assert.ok(stored);

    // The image is served from the app's host to anyone, under a sandboxing policy, as a website can embed it.
    const served = await app.dispatch("", new Request(`${app.origin}/files/main/concepts/${concept.key}`));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("Content-Type"), "image/png");
    assert.match(served.headers.get("Content-Security-Policy") ?? "", /sandbox/);
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), new Uint8Array(png));

    // Refusals: no identity, a stale revision (which leaves no orphaned file), a non-image, an empty body.
    assert.equal((await app.dispatch("", new Request(`${app.origin}${concepts}?${query}`, { method: "POST", headers: { "Content-Type": "image/png" }, body: png }))).status, 401);
    assert.equal((await upload(`${concepts}?${query}`, png)).status, 409);
    assert.equal((await bucket.list({ prefix: "concepts/" })).objects.length, 1);
    assert.equal((await upload(`${concepts}?revision=2`, png, "text/html")).status, 415);
    assert.equal((await upload(`${concepts}?revision=2`, new Uint8Array())).status, 400);
    assert.equal((await upload(concepts, png)).status, 400);

    // Publishing writes one Document, evidence_for the revision, with the image URL and prompt.
    const publish = (body: unknown) => app.call(`${concepts}/publish`, member, { method: "POST", body, workflowHost: scope("POST") });
    assert.equal((await publish({ productRevisionId: revisionId, revision: 1 })).status, 409);
    const published = await publish({ productRevisionId: revisionId, revision: 2 });
    assert.equal(published.status, 200, await published.clone().text());
    assert.deepEqual(await published.json(), {
      documentId: "22222222-2222-4222-8222-222222222222",
      url: "https://wiki.org.example/documents/22222222-2222-4222-8222-222222222222",
    });
    assert.equal(double.applied.length, 1);
    const apply = double.applied[0] as { installationId: string; action: string; input: { requestKey: string; preconditions: unknown[]; operations: { ref: string; attributes: Record<string, unknown> }[] } };
    assert.deepEqual([apply.installationId, apply.action], [wiki, "graph.apply"]);
    assert.equal(apply.input.requestKey, `workshop-concepts:${project.id}:2:${revisionId}`);
    assert.deepEqual(apply.input.preconditions, [{ type: "graph-node", id: revisionId, revision: 4 }]);
    assert.deepEqual(apply.input.operations.map((operation) => operation.ref), ["$document", "$evidence-for", "$documents", "$applies-definition"]);
    const body = JSON.parse(String(apply.input.operations[0].attributes.body));
    assert.deepEqual(body.images.map((image: { artifact: { uri: string }; prompt: string }) => [image.artifact.uri, image.prompt]), [[`${app.origin}/files/main/concepts/${concept.key}`, "A sensor in a plant pot"]]);
    assert.equal(apply.input.operations[1].attributes.toId, revisionId);
    // A missing revision is reported; no write happens.
    assert.equal((await publish({ productRevisionId: "33333333-3333-4333-8333-333333333333", revision: 2 })).status, 404);
    assert.equal(double.applied.length, 1);

    // Removing a concept drops its reference and its file; nothing is left to publish.
    const remove = (revision: number) => app.call(`${concepts}/${concept.id}`, member, { method: "DELETE", body: { revision } });
    assert.equal((await remove(1)).status, 409);
    const removed = await remove(2);
    assert.equal(removed.status, 200, await removed.clone().text());
    const emptied = (await removed.json()) as Project;
    assert.deepEqual([emptied.revision, emptied.concepts], [3, []]);
    assert.equal(await bucket.get(`concepts/${concept.key}`), null);
    assert.equal((await app.dispatch("", new Request(`${app.origin}/files/main/concepts/${concept.key}`))).status, 404);
    assert.equal((await remove(3)).status, 404);
    assert.equal((await publish({ productRevisionId: revisionId, revision: 3 })).status, 409);
  } finally {
    await app.dispose();
  }
});
