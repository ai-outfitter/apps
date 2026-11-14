/** Local cross-app acceptance scenario; synthetic Artera concept, no provider calls.
 * Run after preparing Onto, Marketing, Presentations and Workshop test packages. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { typeIds, digest } from "@ai-outfitter/creative-workflow";
import opencascade from "replicad-opencascadejs";
import { setOC, makeBox } from "replicad";
const owner = {
  userId: "reviewer",
  organizationId: "artera-fixture",
  role: "owner",
};
const id = (n: number) =>
  `cfd00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const apps: any[] = [];
const onto = await appWorker(
  "onto",
  appArtifact(new URL("../apps/onto", import.meta.url), "operational"),
  "flow-onto",
);
apps.push(onto);
const call = async (app: any, path: string, body?: any, host = false) => {
  const response = await app.call(path, owner, {
    ...(body ? { method: "POST", body } : {}),
    ...(host
      ? {
          workflowHost: {
            organizationId: owner.organizationId,
            installationId: app.installationId,
            userId: owner.userId,
            packageHash: "fixture",
            phase: "interactive",
            initiation: "member",
            expiresAt: Date.now() + 60000,
          },
        }
      : {}),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const action = (app: any, name: string, input: any, host = false) =>
  call(app, "/api/internal/actions/v1/call", { action: name, input }, host);
const graph = async (
  app: any,
  query: string,
  variables: any = {},
  host = false,
) => {
  const result: any = await action(
    app,
    query.startsWith("mutation") ? "graph.mutate" : "graph.graphql",
    { query, variables },
    host,
  );
  assert.ok(!result.errors, JSON.stringify(result));
  return result.data;
};
const host = () => ({
  call: async (operation: string, input: any) => {
    if (operation === "entities.types")
      return {
        ok: true,
        value: ["graph-type", "graph-node", "graph-edge"].map((type) => ({
          installationId: onto.installationId,
          type,
          title: type,
          description: "",
          schema: {},
          writable: true,
        })),
      };
    if (input.installationId !== onto.installationId)
      return { ok: false, status: 403, message: "Organization boundary" };
    try {
      if (operation === "entities.get") {
        const { installationId, ...address } = input;
        return {
          ok: true,
          value: await call(onto, "/api/internal/entities/v1/get", address),
        };
      }
      if (operation === "actions.call")
        return {
          ok: true,
          value: await action(onto, input.action, input.input),
        };
      return {
        ok: false,
        status: 400,
        message: "No executor operation allowed in acceptance scenario",
      };
    } catch (error) {
      return { ok: false, status: 500, message: String(error) };
    }
  },
});
try {
  await call(onto, "/api/internal/app-initialize", {});
  for (const name of ["marketing", "presentations", "workshop"])
    apps.push(
      await appWorker(
        name,
        appArtifact(new URL(`../apps/${name}`, import.meta.url), "operational"),
        `flow-${name}`,
        { workflowHost: host },
      ),
    );
  const [, marketing, presentations, workshop] = apps;
  await action(onto, "graph.apply", {
    requestKey: "artera-fixture",
    operations: [
      {
        operation: "create",
        ref: "$description",
        type: "graph-node",
        attributes: {
          id: id(1),
          typeId: "71000000-0000-4000-8000-000000000012",
          title: "Artera spacecraft description",
          body: "Synthetic concept: an orbital growth chamber delivers fresh food. No engineering certification.",
        },
      },
    ],
  });
  const pin = (n: number) => ({
    installationId: onto.installationId,
    type: "graph-node",
    id: id(n),
    revision: 1,
  });
  const commit = async (batchId: string) => {
    if (!batchId) return;
    await action(onto, "batch.submit", { batchId });
    await call(onto, "/api/apps/onto/batches/review", {
      batchId,
      verdict: "approve",
    });
  };
  const stage = async (n: number, kind: string, body: any) => {
    const result = await graph(
      onto,
      "mutation($input:StageCreativeRecordInput!){stageCreativeRecord(input:$input)}",
      {
        input: {
          id: id(n),
          revision: 0,
          kind,
          title: `Artera ${kind} ${n}`,
          subjectId: id(1),
          body,
        },
      },
    );
    await commit(result.stageCreativeRecord.batchId);
    return result.stageCreativeRecord;
  };
  await stage(2, "CreativeBrief", {
    subject: pin(1),
    purpose: "Explain food delivery from Earth to orbit",
    audience: "Researchers",
  });
  await stage(3, "PromptFragment", {
    id: id(3),
    revision: 1,
    text: "A research growth chamber aboard a spacecraft. Concept illustration.",
    references: [],
  });
  await stage(4, "Storyboard", {
    brief: pin(2),
    items: [
      {
        id: "research",
        title: "Research on Earth",
        narrative: "Grow and test plants in a lab",
        prompt: pin(3),
      },
      {
        id: "orbit",
        title: "Deliver in orbit",
        narrative: "The spacecraft delivers fresh food",
        prompt: pin(3),
      },
    ],
  });
  const frozen = await graph(
    onto,
    "mutation($input:FreezeCreativeInputsInput!){freezeCreativeInputs(input:$input)}",
    {
      input: {
        id: id(5),
        rootId: id(3),
        subjectId: id(1),
        title: "Frozen illustration",
        settings: { model: "fixture-no-generation" },
      },
    },
  );
  await commit(frozen.freezeCreativeInputs.batchId);
  await stage(6, "CreativeCandidate", {
    subject: pin(1),
    snapshot: pin(5),
    artifact: {
      provider: "fixture",
      recordId: "appearance-reference.png",
      contentHash: await digest("explicit synthetic illustration fixture"),
    },
    owner: {
      installationId: presentations.installationId,
      type: "artifact",
      id: "appearance-reference",
    },
    concept: true,
  });
  const selection = await stage(7, "CreativeSelection", {
    use: pin(4),
    slot: "workshop-reference",
    candidate: pin(6),
  });
  const created = await graph(
    workshop,
    "mutation($input:CreateWorkshopProjectInput!){createWorkshopProject(input:$input){id revision}}",
    { input: { example: "cube", name: "Artera growth chamber concept" } },
    true,
  );
  const project = created.createWorkshopProject;
  const handoff = {
    projectId: project.id,
    revision: 1,
    id: id(8),
    request: {
      selection: { ...pin(7), id: selection.recordId },
      purpose: "Explore an envelope for the growth chamber",
      dimensions: "40 mm demonstration cube; not spacecraft dimensions",
      materials: "Unknown",
      interfaces: "Unknown",
      questions: ["Determine actual flight envelope"],
      acceptance: ["Review actual dimensions before engineering approval"],
    },
  };
  await graph(
    workshop,
    "mutation($input:AcceptCreativeHandoffInput!){acceptCreativeHandoff(input:$input)}",
    { input: handoff },
    true,
  );
  await graph(
    workshop,
    "mutation($input:AcceptCreativeHandoffInput!){acceptCreativeHandoff(input:$input)}",
    { input: handoff },
    true,
  );
  const saved: any = await call(
    workshop,
    `/api/apps/workshop/projects/${project.id}`,
  );
  assert.equal(saved.revision, 2);
  assert.equal(saved.creativeHandoffs.length, 1);
  // Explicit local CAD execution, using the same kernel Workshop uses. It is
  // separate from the handoff and is never an automatic image-to-CAD operation.
  setOC(await opencascade());
  const solid = makeBox(
    [0, 0, 0],
    [saved.params.width, saved.params.depth, saved.params.height],
  );
  const step = await solid.blobSTEP().text(),
    mesh = solid.mesh();
  solid.delete();
  assert.match(step, /ISO-10303-21/);
  assert.ok(mesh.vertices.length > 0);
  const polygons = [];
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const points = [];
    for (let j = 0; j < 3; j++) {
      const v = mesh.triangles[i + j] * 3,
        x = mesh.vertices[v],
        y = mesh.vertices[v + 1],
        z = mesh.vertices[v + 2];
      points.push(`${200 + (x - y) * 2},${250 + (x + y) - z * 3}`);
    }
    polygons.push(
      `<polygon points="${points.join(" ")}" fill="#b5d3bd" stroke="#234b3a" stroke-width="1"/>`,
    );
  }
  const render = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="#f5f6f5"/><text x="20" y="30" font-family="sans-serif" font-size="16">Artera concept envelope</text>${polygons.join("")}<text x="20" y="380" font-family="sans-serif" font-size="12">Demonstration only — not engineering approval</text></svg>`;
  if (process.env.CREATIVE_EVIDENCE_DIRECTORY) {
    const directory = resolve(process.env.CREATIVE_EVIDENCE_DIRECTORY);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "concept.step"), step);
    await writeFile(resolve(directory, "concept.svg"), render);
    await writeFile(resolve(directory, "mesh.json"), JSON.stringify(mesh));
  }
  await stage(9, "CreativeCandidate", {
    subject: pin(6),
    ownerRevision: 2,
    artifact: {
      provider: "workshop",
      recordId: `${project.id}/concept.step`,
      version: String(saved.revision),
      contentHash: await digest(step),
    },
    owner: {
      installationId: workshop.installationId,
      type: "project",
      id: project.id,
    },
    concept: true,
  });
  await graph(
    workshop,
    "mutation($input:AttachCreativeResultInput!){attachCreativeResult(input:$input)}",
    {
      input: {
        projectId: project.id,
        revision: 2,
        handoffId: id(8),
        candidate: pin(9),
      },
    },
    true,
  );
  await stage(12, "CreativeCandidate", {
    subject: pin(9),
    artifact: {
      provider: "workshop",
      recordId: `${project.id}/concept.svg`,
      version: String(saved.revision),
      contentHash: await digest(render),
    },
    owner: {
      installationId: workshop.installationId,
      type: "project",
      id: project.id,
    },
    concept: true,
  });
  await stage(10, "CreativeSelection", {
    use: pin(4),
    slot: "presentation-illustration",
    candidate: pin(12),
  });
  await stage(11, "CreativeSelection", {
    use: pin(4),
    slot: "marketing-design-reference",
    candidate: pin(12),
  });
  const marketingRead = await graph(marketing, "{creativeRecords}", {}, true),
    presentationRead = await graph(
      presentations,
      "{creativeRecords}",
      {},
      true,
    );
  for (const read of [marketingRead, presentationRead]) {
    assert.ok(read.creativeRecords.items.some((n: any) => n.id === id(9)));
    assert.equal(
      read.creativeRecords.items.filter(
        (n: any) =>
          n.typeId === typeIds.CreativeSelection &&
          n.body.candidate.id === id(12),
      ).length,
      2,
    );
  }
  assert.deepEqual(marketingRead, presentationRead);
  console.log(
    JSON.stringify({
      scenario: "synthetic Artera cross-app acceptance",
      records: marketingRead.creativeRecords.items.length,
      stepSha256: await digest(step),
      renderSha256: await digest(render),
      meshVertices: mesh.vertices.length,
      providerCalls: 0,
      manufacturingApproval: false,
    }),
  );
} finally {
  for (const app of apps.reverse()) await app.dispose();
}
