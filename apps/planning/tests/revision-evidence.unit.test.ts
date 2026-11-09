import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceBody,
  evidenceURL,
  revisionEvidence,
  screenshotMetadata,
} from "../src/lib/revision-evidence";
import {
  evidenceFixture,
  fixtureItem,
  ids,
} from "./fixtures/revision-evidence";

test("a moving revision's newest bundle excludes older shared-story demonstrations", () => {
  const graph = evidenceFixture();
  const model = revisionEvidence(
    graph,
    fixtureItem(graph.nodes, (node) => node.id === ids.revision),
  );
  assert.deepEqual(
    model.bundles.map((bundle) => bundle.node.id),
    [ids.latest, ids.old],
  );
  const latest = model.bundles[0];
  assert.equal(latest.clean, true);
  assert.deepEqual(latest.commits, ["a".repeat(40)]);
  assert.equal(latest.packageCount, 1);
  assert.equal(latest.evaluations.length, 1);
  const stories = model.stories(latest);
  assert.equal(
    stories[0].media.some((media) => media.includes("old.example")),
    false,
  );
  assert.deepEqual(
    stories[0].demonstrations.map((node) => node.id),
    [ids.demo],
  );
  assert.deepEqual(
    stories[0].flows.map((node) => node.id),
    [ids.flow],
  );
  assert.equal(
    fixtureItem(stories, (story) => story.node.id === ids.missingStory).media
      .length,
    0,
  );
  assert.deepEqual(
    model.stories(model.bundles[1])[0].demonstrations.map((node) => node.id),
    [ids.oldDemo],
  );
});

test("stale, archived and unpinned snapshot members remain visible as gaps", () => {
  const graph = evidenceFixture();
  fixtureItem(graph.nodes, (node) => node.id === ids.story).revision = 2;
  fixtureItem(graph.nodes, (node) => node.id === ids.flow).archived = true;
  fixtureItem(
    graph.edges,
    (edge) => edge.fromId === ids.latest && edge.toId === ids.demo,
  ).properties = {};
  const bundle = revisionEvidence(
    graph,
    fixtureItem(graph.nodes, (node) => node.id === ids.revision),
  ).bundles[0];
  assert.ok(
    bundle.warnings.some((warning) =>
      warning.includes("captured revision 1, current revision 2"),
    ),
  );
  assert.ok(
    bundle.warnings.some((warning) => warning.includes("missing or archived")),
  );
  assert.ok(
    bundle.warnings.some((warning) =>
      warning.includes("captured revision is not recorded"),
    ),
  );
});

test("foreign-subject demonstrations and evaluations cannot establish this revision's evidence", () => {
  const graph = evidenceFixture();
  fixtureItem(graph.nodes, (node) => node.id === ids.demo).body =
    JSON.stringify({
      subject: { id: ids.product, revision: 1 },
      media: ["https://wrong.example/image.png"],
    });
  fixtureItem(graph.nodes, (node) => node.id === ids.evaluation).body =
    JSON.stringify({
      subject: { id: ids.revision },
      evidence: [{ id: ids.old }],
      result: "passed",
    });
  const model = revisionEvidence(
    graph,
    fixtureItem(graph.nodes, (node) => node.id === ids.revision),
  );
  assert.equal(model.bundles[0].demonstrations.length, 0);
  assert.equal(model.bundles[0].evaluations.length, 0);
  assert.equal(model.stories(model.bundles[0])[0].media.length, 0);
  assert.ok(model.bundles[0].warnings.length);
});

test("edited demonstrations and evaluations cannot replace a snapshot's pinned evidence", () => {
  const graph = evidenceFixture();
  const demo = fixtureItem(graph.nodes, (node) => node.id === ids.demo);
  demo.revision = 2;
  demo.body = JSON.stringify({
    subject: { id: ids.revision, revision: 1 },
    media: ["https://changed.example/new.png"],
  });
  fixtureItem(graph.nodes, (node) => node.id === ids.evaluation).revision = 2;
  const model = revisionEvidence(
    graph,
    fixtureItem(graph.nodes, (node) => node.id === ids.revision),
  );
  assert.equal(model.bundles[0].demonstrations.length, 0);
  assert.equal(model.bundles[0].evaluations.length, 0);
  assert.equal(model.stories(model.bundles[0])[0].media.length, 0);
  assert.ok(
    model.bundles[0].warnings.some((warning) =>
      warning.includes("captured revision 1, current revision 2"),
    ),
  );
});

test("image receipts do not dilute the capture source's clean-tree identity", () => {
  const graph = evidenceFixture();
  const source = fixtureItem(graph.nodes, (node) => node.id === ids.source);
  const id = "99000000-0000-4000-8000-000000000020";
  graph.nodes.push({
    ...source,
    id,
    body: JSON.stringify({ sourceCommit: "b".repeat(40), assets: [] }),
  });
  const membership = fixtureItem(
    graph.edges,
    (edge) => edge.fromId === ids.latest && edge.toId === ids.source,
  );
  graph.edges.push({
    ...membership,
    id: "99000000-0000-4000-8000-000000000021",
    toId: id,
  });
  const bundle = revisionEvidence(
    graph,
    fixtureItem(graph.nodes, (node) => node.id === ids.revision),
  ).bundles[0];
  assert.equal(bundle.clean, true);
  assert.deepEqual(bundle.commits, ["a".repeat(40)]);
  assert.deepEqual(
    bundle.sources.map((node) => node.id),
    [ids.source],
  );
});

test("record creation time is not reported as an unknown capture time", () => {
  const graph = evidenceFixture();
  fixtureItem(graph.nodes, (node) => node.id === ids.source).body =
    JSON.stringify({
      sourceAtCapture: { commit: "a".repeat(40), dirty: false },
    });
  fixtureItem(graph.nodes, (node) => node.id === ids.demo).body =
    JSON.stringify({ subject: { id: ids.revision, revision: 1 }, media: [] });
  const bundle = revisionEvidence(
    graph,
    fixtureItem(graph.nodes, (node) => node.id === ids.revision),
  ).bundles.find((bundle) => bundle.node.id === ids.latest);
  assert.equal(bundle?.capturedAt, undefined);
});

test("malformed records and unsafe media URLs degrade without executing markup", () => {
  assert.deepEqual(evidenceBody("```json\n{invalid}\n```"), {});
  assert.deepEqual(evidenceBody("```json\n[1,2]\n```"), {});
  for (const url of [
    "javascript:alert(1)",
    "data:image/svg+xml,x",
    "https://user:secret@example.com/image.png",
  ])
    assert.equal(evidenceURL(url, "https://wiki.example"), null);
  assert.equal(
    evidenceURL("/evidence/desktop.png", "https://wiki.example")?.preview,
    true,
  );
  assert.equal(
    evidenceURL("https://another.example/image.png", "https://wiki.example")
      ?.preview,
    false,
  );
  assert.equal(
    evidenceURL("http://127.0.0.1:4397/image.png", "https://wiki.example")
      ?.local,
    true,
  );
  const graph = evidenceFixture();
  fixtureItem(graph.nodes, (node) => node.id === ids.source).body =
    "not structured";
  const bundle = revisionEvidence(
    graph,
    fixtureItem(graph.nodes, (node) => node.id === ids.revision),
  ).bundles[0];
  assert.deepEqual(bundle.commits, []);
  assert.equal(bundle.clean, undefined);
});

test("screenshot context uses the longest path and combines only equal-path receipts", () => {
  const metadata = screenshotMetadata([
    {path:"settings/page.png",route:"/settings",viewport:"desktop"},
    {path:"page.png",route:"/",pageTitle:"Wrong page"},
    {path:"settings/page.png",pageTitle:"Settings"},
  ], "/capture/settings/page.png");
  assert.deepEqual(metadata, {path:"settings/page.png",route:"/settings",viewport:"desktop",pageTitle:"Settings"});
  assert.deepEqual(screenshotMetadata([{path: false},{}], "/page.png"), {});
});
