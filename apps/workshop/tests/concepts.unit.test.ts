import assert from "node:assert/strict";
import test from "node:test";
import { ConceptSchema, makeProject, ProjectSchema } from "../src/lib/project";
import { conceptOperations, WIKI_IDS } from "../src/server/concepts";

const concept = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  key: `00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000010${n}.png`,
  contentType: "image/png" as const,
  sha256: "a".repeat(64),
  prompt: n === 1 ? "A sensor in a plant pot" : "",
  model: n === 1 ? "image-model" : "upload",
  caption: n === 1 ? "In the pot" : "",
  createdAt: "2026-11-02T10:00:00.000Z",
});

test("a project keeps concept references, never image bytes", () => {
  const project = makeProject("cube");
  assert.deepEqual(project.concepts, []);
  assert.deepEqual(ProjectSchema.parse({ ...project, concepts: [concept(1)] }).concepts, [concept(1)]);
  // Keys are the project and concept ids with an image extension; nothing else reaches storage.
  assert.equal(ConceptSchema.safeParse({ ...concept(1), key: "../etc/passwd" }).success, false);
  assert.equal(ConceptSchema.safeParse({ ...concept(1), key: `${concept(1).key}.html` }).success, false);
});

test("publishing is one Document evidence_for the revision, with the images and prompts", () => {
  const subject = { id: "11111111-1111-4111-8111-111111111111", revision: 3, title: "SNSP-1 Indoor rev A" };
  const operations = conceptOperations({
    project: { id: "00000000-0000-4000-8000-000000000001", name: "Indoor sensor", concepts: [concept(1), concept(2)] },
    origin: "https://workshop.example.test",
    installationId: "workshop-installation",
    subject,
    definition: { id: WIKI_IDS.designConcept, revision: 1 },
    evidenceForTypeId: "7b000000-0000-4000-8000-000000000003",
  });
  assert.deepEqual(
    operations.map((operation) => [operation.ref, operation.type, operation.attributes.typeId]),
    [
      ["$document", "graph-node", WIKI_IDS.Document],
      ["$evidence-for", "graph-edge", "7b000000-0000-4000-8000-000000000003"],
      ["$documents", "graph-edge", WIKI_IDS.documents],
      ["$applies-definition", "graph-edge", WIKI_IDS.applies_definition],
    ],
  );
  const document = operations[0].attributes as { title: string; body: string };
  assert.equal(document.title, "SNSP-1 Indoor rev A — design concepts");
  const body = JSON.parse(document.body);
  assert.deepEqual(body.subject, { id: subject.id, revision: 3 });
  assert.deepEqual(body.definition, { id: WIKI_IDS.designConcept, revision: 1 });
  assert.deepEqual(
    body.images.map((image: { artifact: { uri: string }; prompt: string; model: string; caption?: string }) => [image.artifact.uri, image.prompt, image.model, image.caption]),
    [
      [`https://workshop.example.test/files/main/concepts/${concept(1).key}`, "A sensor in a plant pot", "image-model", "In the pot"],
      [`https://workshop.example.test/files/main/concepts/${concept(2).key}`, "", "upload", undefined],
    ],
  );
  assert.deepEqual(body.images[0].artifact, {
    provider: "workshop",
    recordId: `workshop-installation/main/concepts/${concept(1).key}`,
    uri: `https://workshop.example.test/files/main/concepts/${concept(1).key}`,
    contentHash: "a".repeat(64),
  });
  for (const edge of operations.slice(1))
    assert.deepEqual([edge.attributes.fromId, edge.attributes.toId], ["$document", edge.ref === "$applies-definition" ? WIKI_IDS.designConcept : subject.id]);
});
