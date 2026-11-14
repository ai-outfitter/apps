import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
  createWorkshopProject,
  projectFrom,
  getWorkshopProject,
} from "../src/server/projects";
import {
  acceptCreativeHandoff,
  attachCreativeResult,
} from "../src/server/creative";
import { typeIds } from "@ai-outfitter/creative-workflow";
const id = (n: number) =>
  `bbb00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("selected concept creates an idempotent design request and links a Workshop result without changing CAD", async (t) => {
  const client = createClient({ url: ":memory:" });
  t.after(() => client.close());
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  const identity: any = {
    userId: "member",
    installationId: "workshop",
    canEdit: true,
    owner: { kind: "organization", id: "artera" },
  };
  const project = await createWorkshopProject(
    db,
    identity,
    projectFrom({ example: "cube" }),
  );
  const pin = (n: number) => ({
    installationId: "onto",
    type: "graph-node",
    id: id(n),
    revision: 1,
  });
  const records: any = {
    [id(1)]: {
      revision: 1,
      attributes: {
        typeId: typeIds.CreativeSelection,
        body: JSON.stringify({ candidate: pin(2) }),
      },
    },
    [id(2)]: {
      revision: 1,
      attributes: {
        typeId: typeIds.CreativeCandidate,
        body: JSON.stringify({
          concept: true,
          artifact: {
            provider: "repository",
            recordId: "mockup.png",
            contentHash: "a".repeat(64),
          },
        }),
      },
    },
    [id(3)]: {
      revision: 1,
      attributes: {
        typeId: typeIds.CreativeCandidate,
        body: JSON.stringify({
          subject: pin(2),
          concept: false,
          ownerRevision: 2,
          owner: {
            installationId: "workshop",
            type: "project",
            id: project.id,
          },
          artifact: {
            provider: "workshop",
            recordId: "preview.stl",
            version: "2",
            contentHash: "b".repeat(64),
          },
        }),
      },
    },
  };
  const host = {
    call: async (name: string, input: any) => {
      if (name === "entities.types")
        return ["graph-type", "graph-node", "graph-edge"].map((type) => ({
          type,
          installationId: "onto",
          writable: true,
        }));
      if (name === "entities.get") {
        if (input.installationId !== "onto")
          throw new Response("", { status: 403 });
        return records[input.id];
      }
      throw Error("Unexpected execution: " + name);
    },
  };
  const c: any = { identity, db: () => db, host: () => host };
  const input = {
    projectId: project.id,
    revision: 1,
    id: id(4),
    request: {
      selection: pin(1),
      purpose: "Artera growth module appearance reference",
      dimensions: "Unknown",
      materials: "Unknown",
      interfaces: "Unknown",
      questions: ["Envelope?"],
      acceptance: ["Review dimensions before CAD approval"],
    },
  };
  await acceptCreativeHandoff(c, input);
  await acceptCreativeHandoff(c, input);
  const after = await getWorkshopProject(db, project.id);
  assert.equal(after.revision, 2);
  assert.equal(after.creativeHandoffs?.length, 1);
  assert.deepEqual(after.params, project.params);
  assert.equal(after.workspace, project.workspace);
  await attachCreativeResult(c, {
    projectId: project.id,
    revision: 2,
    handoffId: id(4),
    candidate: pin(3),
  });
  await attachCreativeResult(c, {
    projectId: project.id,
    revision: 2,
    handoffId: id(4),
    candidate: pin(3),
  });
  assert.equal((await getWorkshopProject(db, project.id)).revision, 3);
  await assert.rejects(
    () => acceptCreativeHandoff(c, { ...input, id: id(5) }),
    (e: any) => e.status === 409,
  );
  await assert.rejects(
    () =>
      acceptCreativeHandoff(c, {
        ...input,
        request: {
          ...input.request,
          selection: { ...pin(1), installationId: "foreign" },
        },
      }),
    (e: any) => e.status === 403,
  );
});
