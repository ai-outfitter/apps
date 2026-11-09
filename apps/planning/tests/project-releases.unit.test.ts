import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {
  projectReleaseRecords,
  readProjectReleases,
  releaseMarkdown,
} from "../src/server/project-releases";
import {
  canonicalReleaseProject,
  projectReleasesFixture,
  releaseId,
  releaseProviders,
} from "./fixtures/project-releases";

test("release review follows canonical project references and documents on its release only", () => {
  const graph = projectReleasesFixture();
  const result = projectReleaseRecords(graph, "planning", releaseId(9));
  assert.deepEqual(
    result.releases.map((n) => n.id),
    [releaseId(2)],
  );
  assert.deepEqual(
    result.documents.map((n) => n.id),
    [releaseId(3)],
  );
  assert.deepEqual(result.demonstrations, {
    [releaseId(3)]: [
      {
        id: releaseId(7),
        title: "Check a plant — abc12345",
        media: [
          "https://evidence.example/bundle/images/check/001-desktop-page.png",
        ],
      },
    ],
  });
  const none = { releases: [], documents: [], demonstrations: {} };
  assert.deepEqual(projectReleaseRecords(graph, "missing", releaseId(9)), none);
  graph.edges[0].archived = true;
  assert.deepEqual(projectReleaseRecords(graph, "planning", releaseId(9)), none);
});

test("ambiguous canonical references fail closed; archived and retired records stay hidden", () => {
  const graph = projectReleasesFixture();
  graph.nodes[3].source = graph.nodes[0].source;
  assert.throws(
    () => projectReleaseRecords(graph, "planning", releaseId(9)),
    (e: unknown) => e instanceof Response && e.status === 409,
  );
  graph.nodes[3].archived = true;
  graph.nodes[2].body = '{"status":"retired"}';
  assert.equal(
    projectReleaseRecords(graph, "planning", releaseId(9)).documents.length,
    0,
  );
});

test("release presentation retains hypothetical quotes and unresolved questions", () => {
  const body = JSON.parse(projectReleasesFixture().nodes[1].body);
  const md = releaseMarkdown(
    JSON.stringify({ ...body, announceTarget: "Target to be reviewed" }),
  );
  assert.match(md, /Plant-care alerts/);
  assert.match(md, /Automatic watering Later release/);
  assert.match(md, /Home grower \(hypothetical\)/);
  assert.match(md, /Shipping date/);
  assert.match(md, /Announcement target\n\nTarget to be reviewed/);
  assert.match(releaseMarkdown("invalid"), /details are unavailable/);
});

test("reader checks the canonical project first and propagates Wiki failure without writes", async () => {
  const calls: string[] = [];
  let allowProject = false;
  const host = {
    async call(operation: string) {
      calls.push(operation);
      if (operation === "entities.types") return releaseProviders();
      if (operation === "entities.get") {
        if (!allowProject) throw new Response("Forbidden", { status: 403 });
        return canonicalReleaseProject;
      }
      if (operation === "actions.call")
        throw new Response("Wiki unavailable", { status: 503 });
      throw new Error(`Unexpected operation: ${operation}`);
    },
  } as unknown as WorkflowHost<"interactive">;
  await assert.rejects(
    readProjectReleases(host, "planning", releaseId(9)),
    (e: unknown) => e instanceof Response && e.status === 403,
  );
  assert.equal(calls.includes("actions.call"), false);
  allowProject = true;
  await assert.rejects(
    readProjectReleases(host, "planning", releaseId(9)),
    (e: unknown) => e instanceof Response && e.status === 503,
  );
  assert.ok(
    calls.every((call) =>
      ["entities.types", "entities.get", "actions.call"].includes(call),
    ),
  );
});
