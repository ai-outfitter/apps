import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import {
  beginTransfer,
  exportTransfer,
  importTransfer,
  finishTransfer,
  transferReceipt,
} from "../src/video-transfer.ts";
import { digest } from "../src/index.ts";
const id = (n: number) =>
  `abc00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function fixture(installationId: string) {
  const db = createClient({ url: ":memory:" });
  for (const name of [
    "0000_video_productions.sql",
    "0001_video_transfer.sql",
  ]) {
    const sql = await readFile(
      new URL(`../../../apps/marketing/migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const part of sql.split("--> statement-breakpoint"))
      await db.execute(part);
  }
  const files = new Map();
  const c: any = {
    identity: {
      installationId,
      userId: "member",
      canEdit: true,
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
    videoFiles: () => ({ get: async ({ key }: any) => files.get(key) }),
    host: () => ({
      call: async () => {
        throw Error("unbound host");
      },
    }),
  };
  return { db, c, files };
}
test("transfer preserves IDs, versions, receipts and media; source sealed and acceptance verifies current destination metadata", async (t) => {
  const source = await fixture("planning"),
    target = await fixture("marketing");
  t.after(() => {
    source.db.close();
    target.db.close();
  });
  const bytes = new TextEncoder().encode("fixture bytes"),
    sha256 = await digest(bytes),
    asset = { id: id(2), productionId: id(1), size: bytes.length, sha256 };
  await source.db.execute({
    sql: "INSERT INTO planning_video_productions VALUES (?,?,2,?,1,2)",
    args: [id(1), "planning", '{"title":"Artera"}'],
  });
  await source.db.execute({
    sql: "INSERT INTO planning_video_versions VALUES (?,?,1,?)",
    args: [id(1), "planning", '{"title":"Earlier"}'],
  });
  await source.db.execute({
    sql: "INSERT INTO planning_video_takes VALUES (?,?,?,?,?)",
    args: [
      id(3),
      "planning",
      id(1),
      4,
      JSON.stringify({
        state: "completed",
        providerRequestId: "preserve-receipt",
      }),
    ],
  });
  await source.db.execute({
    sql: "INSERT INTO planning_video_assets VALUES (?,?,?,?,1)",
    args: [id(2), "planning", id(1), JSON.stringify(asset)],
  });
  target.c.host = () => ({
    call: async (_name: string, input: any) => {
      assert.equal(input.installationId, "planning");
      return { data: { videoTransfer: await exportTransfer(source.c, id(1)) } };
    },
  });
  source.c.host = () => ({
    call: async (_name: string, input: any) => {
      assert.equal(input.installationId, "marketing");
      return {
        data: { videoTransferReceipt: await transferReceipt(target.c, id(1)) },
      };
    },
  });
  await beginTransfer(source.c, {
    id: id(1),
    revision: 2,
    targetInstallationId: "marketing",
  });
  const first = await importTransfer(target.c, {
    id: id(1),
    sourceInstallationId: "planning",
  });
  assert.equal(
    (
      await importTransfer(target.c, {
        id: id(1),
        sourceInstallationId: "planning",
      })
    ).hash,
    first.hash,
  );
  await assert.rejects(
    () =>
      source.db.execute({
        sql: "UPDATE planning_video_takes SET revision=5 WHERE id=?",
        args: [id(3)],
      }),
    /sealed/,
  );
  await assert.rejects(
    () => finishTransfer(source.c, id(1)),
    (e: any) => e.status === 409,
  );
  target.files.set(`${id(1)}/${id(2)}`, { size: bytes.length, sha256 });
  await target.db.execute({
    sql: "UPDATE planning_video_assets SET ready=1 WHERE id=?",
    args: [id(2)],
  });
  assert.equal((await finishTransfer(source.c, id(1))).state, "complete");
  assert.equal((await finishTransfer(source.c, id(1))).state, "complete");
  assert.equal(
    (await target.db.execute("SELECT body FROM planning_video_takes")).rows[0]
      .body,
    JSON.stringify({
      state: "completed",
      providerRequestId: "preserve-receipt",
    }),
  );
  await target.db.execute("UPDATE planning_video_productions SET revision=3");
  await assert.rejects(
    () => transferReceipt(target.c, id(1)),
    (e: any) => e.status === 409,
  );
  const foreign = {
    ...target.c,
    identity: { ...target.c.identity, installationId: "foreign" },
  };
  await assert.rejects(
    () =>
      importTransfer(foreign, { id: id(1), sourceInstallationId: "planning" }),
    (e: any) => e.status === 403,
  );
});
