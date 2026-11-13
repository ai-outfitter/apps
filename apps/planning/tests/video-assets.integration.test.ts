import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
const member = { userId: "reviewer", organizationId: "sunny", role: "member" };
test("private video page and download use stored bytes and reject unauthenticated requests", async () => {
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "video-review",
  );
  try {
    const id = "11111111-1111-4111-8111-111111111111",
      assetId = "22222222-2222-4222-8222-222222222222";
    const packet = {
      title: "Sunny Launch",
      message: "Find your spot",
      audience: "Gardeners",
      style: "Photoreal",
      channel: "instagram",
      concept: true,
      shots: [],
    };
    await app.database
      .prepare("INSERT INTO planning_video_productions VALUES (?,?,1,?,1,1)")
      .bind(id, app.installationId, JSON.stringify(packet))
      .run();
    const bytes = new TextEncoder().encode(
        "synthetic download fixture; not a playable video",
      ),
      sha256 = createHash("sha256").update(bytes).digest("hex"),
      key = `${id}/${assetId}`;
    const asset = {
      id: assetId,
      productionId: id,
      productionRevision: 1,
      kind: "final",
      filename: "sunny.mp4",
      contentType: "video/mp4",
      size: bytes.length,
      sha256,
    };
    await app.database
      .prepare("INSERT INTO planning_video_assets VALUES (?,?,?,?,1)")
      .bind(assetId, app.installationId, id, JSON.stringify(asset))
      .run();
    await app.database
      .prepare("INSERT INTO app_storage_objects VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(
        assetId,
        "video",
        "productions",
        key,
        "video/mp4",
        bytes.length,
        sha256,
        "organization",
        Date.now() + 60000,
        "fixture",
        Date.now(),
      )
      .run();
    await (
      await app.bucket("video")
    ).put(`productions/${key}`, bytes, {
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: { sha256 },
    });
    const page = await app.call(`/videos/${id}`, member);
    assert.equal(page.status, 200, await page.clone().text());
    const html = await page.text();
    assert.match(html, /Download MP4/);
    assert.match(html, /Concept preview/);
    assert.match(html, /<video/);
    const response = await app.call(
      `/api/apps/planning/video-assets/${assetId}?download`,
      member,
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="sunny-launch-v1.mp4"',
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.notEqual(
      (await app.call(`/api/apps/planning/video-assets/${assetId}?download`))
        .status,
      200,
    );
    assert.equal(
      (
        await app.call(
          `/api/apps/planning/video-assets/33333333-3333-4333-8333-333333333333`,
          member,
        )
      ).status,
      404,
    );
  } finally {
    await app.dispose();
  }
});

test("MCP mutation reserves, verifies and commits private media without exposing a provider key", async () => {
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "video-upload",
  );
  try {
    const id = "11111111-1111-4111-8111-111111111111",
      assetId = "44444444-4444-4444-8444-444444444444";
    await app.database
      .prepare("INSERT INTO planning_video_productions VALUES (?,?,1,?,1,1)")
      .bind(
        id,
        app.installationId,
        JSON.stringify({ title: "Video", shots: [] }),
      )
      .run();
    const bytes = new TextEncoder().encode("verified bytes"),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const input = {
      id: assetId,
      productionId: id,
      productionRevision: 1,
      kind: "final",
      filename: "demo.mp4",
      contentType: "video/mp4",
      size: bytes.length,
      sha256,
    };
    const mutate = async (
      name: string,
      field: string,
      input: unknown,
      role = "owner",
    ) => {
      const response = await app.call(
        "/api/internal/actions/v1/call",
        { ...member, role },
        {
          method: "POST",
          body: {
            action: "graph.mutate",
            input: {
              query: `mutation($input:${name}Input!){${field}(input:$input)}`,
              variables: { input },
            },
          },
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as any;
    };
    const denied = await mutate(
      "ReserveVideoAsset",
      "reserveVideoAsset",
      input,
      "member",
    );
    assert.ok(denied.errors?.length);
    const reserved = await mutate(
      "ReserveVideoAsset",
      "reserveVideoAsset",
      input,
    );
    assert.ok(reserved.data?.reserveVideoAsset, reserved.errors?.[0]?.message);
    const ticket = reserved.data.reserveVideoAsset.upload;
    assert.match(ticket.url, /^outfitter-upload:/);
    const staging = ticket.url
      .slice("outfitter-upload:video/".length)
      .split("?")[0];
    await (
      await app.bucket("video")
    ).put(staging, new Uint8Array(bytes.length));
    const bad = await mutate("CommitVideoAsset", "commitVideoAsset", {
      productionId: id,
      id: assetId,
    });
    assert.ok(bad.errors?.length, "bad digest refused");
    await (await app.bucket("video")).put(staging, bytes);
    const done = await mutate("CommitVideoAsset", "commitVideoAsset", {
      productionId: id,
      id: assetId,
    });
    assert.equal(done.data.commitVideoAsset.ready, true);
    const response = await app.call(
      `/api/apps/planning/video-assets/${assetId}?download`,
      member,
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  } finally {
    await app.dispose();
  }
});

test("authenticated HTTP upload enforces editor access and the reserved digest", async () => {
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "video-http",
  );
  try {
    const id = "11111111-1111-4111-8111-111111111111",
      assetId = "55555555-5555-4555-8555-555555555555";
    const bytes = new TextEncoder().encode(JSON.stringify("private media")),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    await app.database
      .prepare("INSERT INTO planning_video_productions VALUES (?,?,1,?,1,1)")
      .bind(
        id,
        app.installationId,
        JSON.stringify({ title: "Private", shots: [] }),
      )
      .run();
    const asset = {
      id: assetId,
      productionId: id,
      productionRevision: 1,
      kind: "final",
      filename: "demo.mp4",
      contentType: "video/mp4",
      size: bytes.length,
      sha256,
      transport: "http",
    };
    await app.database
      .prepare("INSERT INTO planning_video_assets VALUES (?,?,?,?,0)")
      .bind(assetId, app.installationId, id, JSON.stringify(asset))
      .run();
    const path = `/api/apps/planning/video-assets/${assetId}`;
    const request = (value: string) => ({ method: "PUT", body: value });
    assert.equal(
      (await app.call(path, member, request("private media"))).status,
      403,
    );
    assert.equal(
      (
        await app.call(
          path,
          { ...member, role: "owner" },
          request("wrong bytes!!"),
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await app.call(
          path,
          { ...member, role: "owner" },
          request("private media"),
        )
      ).status,
      200,
    );
    assert.deepEqual(
      new Uint8Array(await (await app.call(path, member)).arrayBuffer()),
      bytes,
    );
  } finally {
    await app.dispose();
  }
});

test("read-only demo health does not require private operational media storage", async () => {
 const app=await appWorker("planning",appArtifact(new URL("..",import.meta.url),"demo"),"video-demo-health");
 try {const response=await app.call("/__health");assert.equal(response.status,200);assert.equal((await response.json() as {status:string}).status,"ok");}finally{await app.dispose()}
});
