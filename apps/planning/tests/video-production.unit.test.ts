import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import {
  saveProduction,
  readVideos,
  prepareTake,
  updateTake,
  reserveAsset,
  commitAsset,
} from "../src/server/video-production";
import { downloadName, videoPacket } from "../src/lib/video-production";
const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const packet = {
  product: {
    installationId: "onto",
    type: "graph-node",
    id: id(1),
    revision: 1,
  },
  title: "A plant for this spot?",
  audience: "Apartment gardeners",
  message: "Find your spot",
  channel: "instagram",
  style: "Photorealistic",
  concept: true,
  shots: [
    {
      id: id(2),
      title: "Room",
      duration: 3,
      narration: "Find your spot",
      prompt: "A bright empty corner",
    },
  ],
};
async function fixture() {
  const client = createClient({ url: ":memory:" });
  const sql = await readFile(
    new URL("../migrations/0013_video_productions.sql", import.meta.url),
    "utf8",
  );
  for (const part of sql.split("--> statement-breakpoint"))
    await client.execute(part);
  const store = {
    query: async (s: any) =>
      (await client.execute({ sql: s.sql, args: s.params ?? [] })).rows,
    batch: async (ss: any[]) =>
      client.batch(
        ss.map((s) => ({ sql: s.sql, args: s.params ?? [] })),
        "write",
      ),
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
        assert.equal(
          input.revision,
          undefined,
          "entity address has no revision field",
        );
        return { ref: input, revision: 1, attributes: {} };
      }
      throw Error(name);
    },
  };
  const files = {
    uploadTicket: () => ({ url: "outfitter-upload:test", method: "PUT" }),
    takeUpload: async () => new Uint8Array([1, 2]),
    put: async () => ({}),
    discardUpload: async () => {},
  };
  const c = {
    identity: {
      installationId: "planning-a",
      userId: "editor",
      canEdit: true,
      owner: { kind: "organization", id: "a" },
    },
    store: () => store,
    host: () => host,
    videoFiles: () => files,
  } as any;
  return { c, client };
}
const status = (code: number) => (e: unknown) =>
  e instanceof Response && e.status === code;
test("productions preserve revisions, reject stale writes and isolate owners", async () => {
  const { c, client } = await fixture();
  try {
    const input = { id: id(3), revision: 0, packet };
    const a = await saveProduction(c, input);
    assert.equal(a.revision, 1);
    assert.equal((await saveProduction(c, input)).revision, 1);
    await assert.rejects(
      saveProduction(
        { ...c, identity: { ...c.identity, canEdit: false } },
        input,
      ),
      status(403),
    );
    assert.equal(
      (
        await readVideos(
          { ...c, identity: { ...c.identity, installationId: "other" } },
          {},
        )
      ).items.length,
      0,
    );
    await assert.rejects(
      saveProduction(c, { ...input, packet: { ...packet, title: "Conflict" } }),
      status(409),
    );
    await saveProduction(c, {
      ...input,
      revision: 1,
      packet: { ...packet, title: "Revision two" },
    });
    assert.equal(
      (await client.execute("SELECT * FROM planning_video_versions")).rows
        .length,
      2,
    );
    assert.equal(
      (await readVideos(c, { id: id(3), revision: 1 })).items[0].packet.title,
      packet.title,
    );
    await assert.rejects(
      saveProduction(c, {
        ...input,
        revision: 2,
        packet: {
          ...packet,
          product: { ...packet.product, installationId: "other" },
        },
      }),
      status(403),
    );
  } finally {
    client.close();
  }
});
test("take claim is revision checked; uncertain submission cannot automatically restart", async () => {
  const { c, client } = await fixture();
  try {
    await saveProduction(c, { id: id(3), revision: 0, packet });
    const input = {
      id: id(4),
      productionId: id(3),
      revision: 1,
      shotId: id(2),
    };
    const take = await prepareTake(c, input);
    assert.equal(take.state, "prepared");
    assert.deepEqual(await prepareTake(c, input), take);
    const claim = { id: id(4), revision: 1, state: "submitting" };
    const claims = await Promise.allSettled([
      updateTake(c, claim),
      updateTake(c, claim),
    ]);
    assert.equal(
      claims.filter((r) => r.status === "fulfilled" && r.value.claimed).length,
      1,
    );
    assert.equal((await updateTake(c, claim)).claimed, false);
    await updateTake(c, {
      id: id(4),
      revision: 2,
      state: "uncertain",
      error: "Connection lost",
    });
    await assert.rejects(
      updateTake(c, { id: id(4), revision: 3, state: "submitting" }),
      status(409),
    );
    await updateTake(c, {
      id: id(4),
      revision: 3,
      state: "submitted",
      providerRequestId: "recovered-receipt",
    });
    await assert.rejects(
      updateTake(c, { id: id(4), revision: 4, state: "completed" }),
      status(400),
    );
    assert.equal((await readVideos(c, { id: id(3) })).items[0].takes.length, 1);
  } finally {
    client.close();
  }
});
test("assets are idempotent and cannot cross productions or accept wrong MIME types", async () => {
  const { c, client } = await fixture();
  try {
    await saveProduction(c, { id: id(3), revision: 0, packet });
    const input = {
      id: id(5),
      productionId: id(3),
      productionRevision: 1,
      kind: "final",
      filename: "sunny.mp4",
      contentType: "video/mp4",
      size: 2,
      sha256: "a".repeat(64),
    };
    assert.equal((await reserveAsset(c, input)).ready, false);
    await assert.rejects(reserveAsset(c, { ...input, size: 3 }), status(409));
    await assert.rejects(
      reserveAsset(c, { ...input, id: id(6), contentType: "image/png" }),
      status(400),
    );
    await assert.rejects(
      commitAsset(c, { id: id(5), productionId: id(9) }),
      status(404),
    );
    await commitAsset(c, { id: id(5), productionId: id(3) });
    assert.equal((await reserveAsset(c, input)).ready, true);
    assert.equal(
      (await readVideos(c, { id: id(3) })).items[0].assets.length,
      1,
    );
  } finally {
    client.close();
  }
});
test("concept labels and filenames remain explicit", () => {
  assert.equal(downloadName("Sunny / App", 2), "sunny-app-v2.mp4");
  assert.equal(
    videoPacket.safeParse({
      ...packet,
      shots: [packet.shots[0], packet.shots[0]],
    }).success,
    false,
  );
});
