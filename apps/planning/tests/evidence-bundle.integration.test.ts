import assert from "node:assert/strict";
import test from "node:test";
import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import type { Graph } from "../src/lib/graph";
import { approve, baseGraph, bundle, documentId, productId, standardTypes as standard, steps } from "./fixtures/evidence-bundle";
import { canonicalReleaseProject, releaseId, releaseProviders } from "./fixtures/project-releases";

// The documented path from an uploaded test-evidence bundle to Planning's
// project Evidence page: evidenceBundleOperations() builds the Onto proposals,
// a member approves them (here: applied to the stubbed Wiki graph), and
// Planning → project → Review evidence shows the Document with its screenshots.

const owner = { userId: "owner", organizationId: "org", role: "owner" };
async function evidencePage(graph: Graph, query = "") {
  const snapshot = () => ({ version: 1, installationId: "wiki", ...graph, selection: null, truncated: false, missingTypes: [] });
  const app = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"), "planning", {
    workflowHost: () => ({
      async call(operation: string, raw: unknown) {
        const input = raw as { installationId: string; id: string; action: string; input?: unknown };
        if (operation === "entities.types") return { ok: true, value: releaseProviders() };
        if (operation === "entities.get")
          return input.installationId === "planning" && input.id === releaseId(9)
            ? { ok: true, value: canonicalReleaseProject }
            : { ok: false, status: 404, message: "Project not found" };
        if (operation === "entities.list") return { ok: true, value: [] };
        assert.equal(operation, "actions.call");
        if (input.action === "graph.query") return { ok: true, value: await queryGraph(snapshot() as never, input.input as never) };
        return { ok: true, value: snapshot() };
      },
    }),
  } as never);
  try {
    const response = await app.call(`/projects/${releaseId(9)}/evidence${query}`, owner, {
      workflowHost: { ...owner, installationId: "planning", packageHash: "fixture", phase: "interactive", expiresAt: Date.now() + 3600000 },
    } as never);
    return { status: response.status, html: await response.text() };
  } finally {
    await app.dispose();
  }
}

const images = (html: string) => [...html.matchAll(/class="planning-evidence-grid"[^]*?<img src="([^"]+)"/g)].map((m) => m[1]);
const headings = (html: string) => [...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);

test("an approved bundle shows on the project's Evidence page with its four screenshots in step order", async () => {
  const graph = baseGraph(standard);
  approve(graph, await bundle(graph));
  const { status, html } = await evidencePage(graph, `?bundle=${documentId}`);
  assert.equal(status, 200);
  assert.match(html, /1 XCUITest passed; 0 failed; 0 skipped/);
  assert.match(html, /Checkout remains mocked/);
  assert.deepEqual(headings(html), steps.map((step, i) => `${i + 1}. ${step.title}`));
  assert.deepEqual(images(html), steps.map((step) => step.url));
  // Markdown images in the Document body are not rendered; the grid is the only image source.
  assert.equal((html.match(/<article[^]*?<\/article>/)?.[0] ?? "").includes("<img"), false);
});

test("a graph without includes_record gets the type from the same batch and still shows the grid", async () => {
  const graph = baseGraph(standard.filter((name) => name !== "includes_record"));
  const ops = await bundle(graph);
  assert.equal(ops[0].type, "graph-type");
  approve(graph, ops);
  assert.equal(images((await evidencePage(graph)).html).length, 4);
});

test("a bundle linked only to the Product is not on the project's Evidence page", async () => {
  const graph = baseGraph(standard);
  approve(graph, await bundle(graph, { projectNodeId: productId }));
  const { status, html } = await evidencePage(graph, `?bundle=${documentId}`);
  assert.equal(status, 404);
  assert.match(html, /not linked to the selected project/);
});

test("Demonstrations without includes_record edges leave the Document without screenshots", async () => {
  const graph = baseGraph(standard);
  approve(graph, (await bundle(graph)).filter((op) => !op.ref.startsWith("$evidence-includes")));
  const { html } = await evidencePage(graph);
  assert.match(html, /1 XCUITest passed/);
  assert.deepEqual(images(html), []);
});
