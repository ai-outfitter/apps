import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {drizzle} from "drizzle-orm/libsql";
import {migrate} from "drizzle-orm/libsql/migrator";
import {submitReleaseEvidence,submitReleaseEvidenceInput,uploadReleaseEvidence} from "../src/server/release-evidence";
import type {IntakeContext} from "../src/server/intake";
import {eq} from "drizzle-orm";
import {releaseEvidenceUploads} from "../src/server/schema";
import { createClient, type InValue } from "@libsql/client";
import { migrateAppDatabase } from "@ai-outfitter/app-sdk/migrations";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { type StorageHost, type StorageObjects, storageMigration } from "@ai-outfitter/app-sdk/storage";
import { admitEvidenceFile, evidenceActions, evidencePublishInput, evidencePublishOutput } from "../src/server/evidence";
import appJson from "../app.json" with { type: "json" };

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const digest = sha256Hex;
const status = (code: number) => (error: unknown) => error instanceof Response && error.status === code;

async function storageHost(): Promise<StorageHost & {appDb:ReturnType<typeof drizzle>}> {
  const client = createClient({ url: ":memory:" });
  const appDb=drizzle(client);
  await migrate(appDb,{migrationsFolder:fileURLToPath(new URL("../migrations",import.meta.url))});
  const db = {
    query: async (s: { sql: string; params?: unknown[] }) => (await client.execute({ sql: s.sql, args: (s.params ?? []) as InValue[] })).rows as Record<string, unknown>[],
    batch: async (steps: { sql: string; params?: unknown[] }[]) => client.batch(steps.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InValue[] })), "write"),
  };
  await migrateAppDatabase({ query: (sql) => db.query({ sql }), batch: async (statements) => { await client.batch(statements, "write"); } }, [storageMigration]);
  const store = new Map<string, ArrayBuffer>();
  const objects: StorageObjects = {
    put: async (key, value) => { store.set(key, value); },
    get: async (key) => (store.has(key) ? { body: new Response(store.get(key)).body as ReadableStream } : null),
    delete: async (keys) => { for (const key of [keys].flat()) store.delete(key); },
  };
  return { appDb,manifest: appJson.storage as StorageHost["manifest"], database: () => db, objects: () => objects, identity: { userId: "nicholas", organizationId: "org", owner: { kind: "organization", id: "org" }, installationId: "foundry", role: "owner", canEdit: true } };
}

test("the app declares the evidence space beside its run screenshots", () => {
  assert.deepEqual(appJson.storage.buckets.main.spaces.evidence, { visibility: "organization", ttl: "1y", maxTtl: "1y" });
});

test("evidence.publish stores a verified bundle file for a year and returns its URL", async () => {
  const context = { storageLocals: { storage: await storageHost() }, origin: "https://foundry.example", identity: { canEdit: true } };
  const input = evidencePublishInput.parse({ bundle: "2026-11-02-abcdef12", path: "images/start/001-desktop-page.png", contentType: "image/png", sha256: await digest(png), base64: png.toString("base64") });
  const stored = evidencePublishOutput.parse(await evidenceActions["evidence.publish"].invoke(context as never, input));
  assert.equal(stored.url, "https://foundry.example/files/main/evidence/2026-11-02-abcdef12/images/start/001-desktop-page.png");
  assert.equal(stored.size, png.length);
  assert.ok(stored.expiresAt && stored.expiresAt > Date.now());
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1 }));
  const saved = evidencePublishOutput.parse(await evidenceActions["evidence.publish"].invoke(context as never, { bundle: "2026-11-02-abcdef12", path: "manifest.json", contentType: "application/json", sha256: await digest(manifest), base64: manifest.toString("base64") }));
  assert.equal(saved.url, "https://foundry.example/files/main/evidence/2026-11-02-abcdef12/manifest.json");
  assert.equal(evidenceActions["evidence.publish"].permitted({ identity: { canEdit: false } } as never), false);
});

test("a full-page screenshot over the run-screenshot cap is stored public; a published path keeps its bytes", async () => {
  const host = await storageHost();
  const context = { storageLocals: { storage: host }, origin: "https://foundry.example", identity: { canEdit: true } };
  // A valid PNG header followed by 1 MiB of padding, over imageDimensions' 512 KiB cap.
  const large = Buffer.concat([png, Buffer.alloc(1024 * 1024)]);
  const input = { bundle: "b2", path: "images/start/001-desktop-page.png", contentType: "image/png" as const, sha256: await digest(large), base64: large.toString("base64") };
  const stored = evidencePublishOutput.parse(await evidenceActions["evidence.publish"].invoke(context as never, evidencePublishInput.parse(input)));
  assert.equal(stored.size, large.length);
  const [row] = await host.database().query({ sql: "SELECT visibility FROM app_storage_objects WHERE key=?", params: ["b2/images/start/001-desktop-page.png"] });
  assert.equal(row?.visibility, "public");
  const again = evidencePublishOutput.parse(await evidenceActions["evidence.publish"].invoke(context as never, evidencePublishInput.parse(input)));
  assert.equal(again.sha256, stored.sha256);
  await assert.rejects(evidenceActions["evidence.publish"].invoke(context as never, evidencePublishInput.parse({ ...input, sha256: await digest(png), base64: png.toString("base64") })), status(409));
});

test("a wrong digest, a mislabelled file or a non-image PNG is refused", async () => {
  const context = { storageLocals: { storage: await storageHost() }, origin: "https://foundry.example", identity: { canEdit: true } };
  const good = { bundle: "b1", path: "images/start/001-desktop-page.png", contentType: "image/png" as const, base64: png.toString("base64") };
  await assert.rejects(evidenceActions["evidence.publish"].invoke(context as never, { ...good, sha256: "0".repeat(64) }), status(422));
  assert.throws(() => admitEvidenceFile(evidencePublishInput.parse({ ...good, path: "manifest.json", sha256: "0".repeat(64) })), status(422));
  assert.throws(() => admitEvidenceFile(evidencePublishInput.parse({ ...good, base64: Buffer.from("not a png").toString("base64"), sha256: "0".repeat(64) })), status(422));
  assert.throws(() => admitEvidenceFile(evidencePublishInput.parse({ bundle: "b1", path: "receipt.json", contentType: "application/json", base64: Buffer.from("{").toString("base64"), sha256: "0".repeat(64) })), status(422));
  assert.throws(() => evidencePublishInput.parse({ ...good, path: "../escape.png", sha256: "0".repeat(64) }));
});

test("SubmitReleaseEvidence tickets verify bytes, preserve immutable paths, expire, and recheck identity",async()=>{
 const host=await storageHost();
 const context={storageLocals:{storage:host},db:()=>host.appDb,origin:"https://foundry.example",identity:host.identity!,actor:{kind:"member",id:"nicholas"},originActor:{kind:"member",id:"nicholas"}} as unknown as IntakeContext;
 const input=submitReleaseEvidenceInput.parse({bundle:"synthetic-release",assets:[{key:crypto.randomUUID(),path:"manifest.json",size:2,contentType:"application/json",sha256:await digest("{}")}]});
 const reserved=await submitReleaseEvidence(context,input);
 assert.equal(reserved.items[0].status,"pending");assert.equal(reserved.instructions[0].code,"UPLOAD_RELEASE_ASSET");
 const ticket=reserved.items[0].result as any;
 const token=new URL(ticket.uploadUrl).pathname.split("/").at(-1)!;
 const request=(body="{}",type="application/json")=>new Request(ticket.uploadUrl,{method:"PUT",headers:{"content-type":type},body});
 await assert.rejects(uploadReleaseEvidence({...context,identity:{...host.identity,userId:"other"}} as never,token,request()),status(404));
 await assert.rejects(uploadReleaseEvidence({...context,identity:{...host.identity,installationId:"foreign"}} as never,token,request()),status(404));
 await assert.rejects(uploadReleaseEvidence({...context,identity:{...host.identity,canEdit:false}} as never,token,request()),status(403));
 await assert.rejects(uploadReleaseEvidence(context,token,request("[]")),status(422));
 await assert.rejects(uploadReleaseEvidence(context,token,request("{}","image/png")),status(422));
 await assert.rejects(uploadReleaseEvidence(context,token,request("{}too long")),status(413));
 const done=await uploadReleaseEvidence(context,token,request());
 assert.equal(done.items[0].status,"complete");assert.deepEqual(done.instructions,[]);
 assert.equal((await submitReleaseEvidence(context,input)).items[0].status,"complete");
 assert.equal((await uploadReleaseEvidence(context,token,request())).items[0].status,"complete","lost upload responses reconcile against immutable stored evidence");
 const changed=await submitReleaseEvidence(context,{...input,assets:[{...input.assets[0],sha256:"f".repeat(64)}]});
 assert.equal(changed.items[0].error?.code,"EVIDENCE_CONFLICT");
 const second={...input,assets:[{...input.assets[0],key:crypto.randomUUID(),path:"receipt.json"}]};
 const expiry=await submitReleaseEvidence(context,second);
 const expiryToken=new URL((expiry.items[0].result as any).uploadUrl).pathname.split("/").at(-1)!;
 await host.appDb.update(releaseEvidenceUploads).set({expiresAt:Date.now()-1}).where(eq(releaseEvidenceUploads.key,second.assets[0].key));
 await assert.rejects(uploadReleaseEvidence(context,expiryToken,request()),status(404));
 const renewed=await submitReleaseEvidence(context,second);
 assert.ok((renewed.items[0].result as any).expiresAt>Date.now());
 await assert.rejects(uploadReleaseEvidence(context,expiryToken,request()),status(404),"renewal must not resurrect expired upload links");
 const rows=await host.appDb.select().from(releaseEvidenceUploads);
 assert.ok(rows.every(row=>row.createdBy==="nicholas"&&row.installationId==="foundry"));
 const ref=await (await import("@ai-outfitter/app-sdk/storage")).storage({storage:host},"main").head({space:"evidence",key:"synthetic-release/manifest.json"});
 assert.equal(ref?.visibility,"organization","new evidence is private by default");
});

test("concurrent evidence publishers pin one immutable digest per bundle path",async()=>{
 const host=await storageHost();
 const context={storageLocals:{storage:host},origin:"https://foundry.example",identity:{canEdit:true}};
 const attempts=await Promise.allSettled(["{}","[]"].map(async text=>evidenceActions["evidence.publish"].invoke(context as never,evidencePublishInput.parse({bundle:"concurrent",path:"manifest.json",contentType:"application/json",sha256:await digest(text),base64:Buffer.from(text).toString("base64")}))));
 assert.equal(attempts.filter(result=>result.status==="fulfilled").length,1);
 const refused=attempts.find(result=>result.status==="rejected") as PromiseRejectedResult;
 assert.ok(refused.reason instanceof Response);assert.equal(refused.reason.status,409);
});
