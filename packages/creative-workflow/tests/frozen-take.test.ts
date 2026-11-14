import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { freeze, typeIds } from "../src/index.ts";
import { prepareTake, publishProduction } from "../src/video-store.ts";
const id = (n: number) =>
  `ddd00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("Marketing uses exact frozen text and refuses incomplete settings before execution; publishing only stages graph review", async (t) => {
  const db = createClient({ url: ":memory:" });
  t.after(() => db.close());
  const sql = await readFile(
    new URL(
      "../../../apps/marketing/migrations/0000_video_productions.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const part of sql.split("--> statement-breakpoint"))
    await db.execute(part);
  const settings = {
    model: "alibaba/wan-3.0/text-to-video",
    duration: 3,
    resolution: "720p",
    aspect_ratio: "9:16",
    audio: false,
    enable_prompt_expansion: false,
    enable_thinking: false,
    enable_safety_checker: true,
    seed: 20261105,
  };
  let snapshot = await freeze({
    root: "scene",
    fragments: [
      {
        id: "scene",
        revision: 1,
        text: "Exact frozen Artera direction",
        references: [],
      },
    ],
    settings,
  });
  const ref = {
    installationId: "onto",
    type: "graph-node",
    id: id(3),
    revision: 1,
  };
  const packet = {
    title: "Artera",
    product: { ...ref, id: id(8) },
    style: "Do not prepend this to a frozen prompt",
    shots: [
      {
        id: id(2),
        duration: 3,
        prompt: "Do not use a changed inline prompt",
        snapshot: ref,
      },
    ],
  };
  await db.execute({
    sql: "INSERT INTO planning_video_productions VALUES (?,?,1,?,1,1)",
    args: [id(1), "marketing", JSON.stringify(packet)],
  });
  const mutations: string[] = [];
  const host = {
    call: async (name: string, input: any) => {
      if (name === "entities.types")
        return ["graph-type", "graph-node", "graph-edge"].map((type) => ({
          installationId: "onto",
          type,
          writable: true,
        }));
      if (name === "entities.get") {
        if (input.id === id(3))
          return {
            revision: 1,
            attributes: {
              typeId: typeIds.GenerationSnapshot,
              body: JSON.stringify(snapshot),
            },
          };
        throw new Response("Not found", { status: 404 });
      }
      if (name === "actions.call") {
        mutations.push(input.action);
        if (input.action === "batch.open") return { batch: { id: id(9) } };
        if (input.action === "batch.add") return { added: 2 };
      }
      throw Error("Unexpected execution or direct write: " + name);
    },
  };
  const c: any = {
    identity: {
      installationId: "marketing",
      canEdit: true,
      userId: "owner",
      owner: { kind: "organization", id: "artera" },
    },
    store: () => ({
      query: async (s: any) =>
        (await db.execute({ sql: s.sql, args: s.params })).rows,
      batch: async (ss: any[]) =>
        db.batch(
          ss.map((s) => ({ sql: s.sql, args: s.params })),
          "write",
        ),
    }),
    host: () => host,
  };
  const take: any = await prepareTake(c, {
    id: id(4),
    productionId: id(1),
    revision: 1,
    shotId: id(2),
  });
  assert.equal(take.request.prompt, snapshot.text);
  assert.equal(take.snapshotHash, snapshot.hash);
  assert.equal(take.state, "prepared");
  assert.deepEqual(mutations, []);
  snapshot = await freeze({
    root: "scene",
    fragments: [
      {
        id: "scene",
        revision: 1,
        text: "Exact frozen Artera direction",
        references: [],
      },
    ],
    settings: { model: settings.model },
  });
  await assert.rejects(
    () =>
      prepareTake(c, {
        id: id(5),
        productionId: id(1),
        revision: 1,
        shotId: id(2),
      }),
    (e: any) => e.status === 400,
  );
  assert.equal(
    (await db.execute("SELECT COUNT(*) AS n FROM planning_video_takes")).rows[0]
      .n,
    1,
  );
  const publication = await publishProduction(c, { id: id(1), revision: 1 });
  assert.equal(publication.state, "draft");
  assert.deepEqual(mutations, ["batch.open", "batch.add"]);
});
