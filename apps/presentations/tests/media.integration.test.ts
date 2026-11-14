import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
const owner = { userId: "owner", organizationId: "artera", role: "owner" };
test("presentation artifacts stay private and have a native review page and matching download", async (t) => {
  const app = await appWorker(
    "presentations",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "presentations-test",
  );
  t.after(() => app.dispose());
  const id = "abc00000-0000-4000-8000-000000000001",
    subjectId = "abc00000-0000-4000-8000-000000000002";
  const bytes = new TextEncoder().encode(
      "%PDF-1.4\n% synthetic download contract fixture",
    ),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const input = {
    id,
    subjectId,
    filename: "artera-deck.pdf",
    contentType: "application/pdf",
    size: bytes.length,
    sha256,
  };
  const response = await app.call("/api/internal/actions/v1/call", owner, {
    method: "POST",
    body: {
      action: "graph.mutate",
      input: {
        query:
          "mutation($input:ReservePresentationArtifactInput!){reservePresentationArtifact(input:$input)}",
        variables: { input },
      },
    },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(!((await response.json()) as any).errors);
  await app.database
    .prepare("INSERT INTO app_storage_objects VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(
      id,
      "video",
      "productions",
      `creative/${id}`,
      "application/pdf",
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
  ).put(`productions/creative/${id}`, bytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { sha256 },
  });
  await app.database
    .prepare("UPDATE creative_media SET ready=1 WHERE id=?")
    .bind(id)
    .run();
  const page = await app.call("/artifacts", owner);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Download PDF/);
  const file = await app.call(`/api/media/${id}?download`, owner);
  assert.equal(file.status, 200);
  assert.match(
    file.headers.get("Content-Disposition") ?? "",
    /attachment.*artera-deck.pdf/,
  );
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  assert.notEqual((await app.call(`/api/media/${id}?download`)).status, 200);
  const missing = await app.call(
    "/api/media/abc00000-0000-4000-8000-000000000099",
    owner,
  );
  assert.equal(missing.status, 404);
});
