import assert from "node:assert/strict";
import test from "node:test";
import { demoImageKeys, demoStatus, evidenceKey } from "../src/server/workspace/demo-handoff";
import { evidenceBytes } from "../src/server/workspace/publication";
import { imageDimensions } from "../src/server/workspace/image-dimensions";

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
const head = "a".repeat(40);
const runId = "11111111-1111-4111-8111-111111111111";
const origin = "https://software-foundry.example";
const status = (value: number) => (error: unknown) => error instanceof Response && error.status === value;
const receipt = (filename: string, headSha = head) => ({
  runId, headSha, createdAt:1, filename, sha256: (filename.includes("mobile") ? "d" : "c").repeat(64), expiresAt: 1,
  width: filename.includes("mobile") ? 390 : 1440, height: filename.includes("mobile") ? 844 : 1000,
  url: `${origin}/files/main/runs/${evidenceKey(runId, headSha, (filename.includes("mobile") ? "d" : "c").repeat(64), filename)}`,
});

test("PNG admission rejects nonimages, huge screenshots and impossible dimensions", () => {
  assert.deepEqual(evidenceBytes(Buffer.from(png).toString("base64")), png);
  assert.throws(() => evidenceBytes(Buffer.from("private session log").toString("base64")), status(422));
  assert.throws(() => evidenceBytes(Buffer.alloc(600000).toString("base64")), status(422));
  const huge = png.slice();
  new DataView(huge.buffer).setUint32(16, 100000);
  assert.throws(() => evidenceBytes(Buffer.from(huge).toString("base64")), status(422));
});

test("receipt dimensions come from original PNG headers, including offset byte views", () => {
  const bytes = png.slice();
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 390); view.setUint32(20, 844);
  const backing = new Uint8Array(bytes.length + 8); backing.set(bytes, 8);
  assert.deepEqual(imageDimensions(backing.subarray(8)), { width: 390, height: 844 });
  view.setUint32(16, 0);
  assert.throws(() => imageDimensions(bytes), status(422));
});

test("the Demo status needs both current-commit viewport images displayed from this run", async () => {
  const desktop = receipt("desktop-summary.png"), mobile = receipt("mobile-summary.png");
  let body = `## Demo\n![Desktop](${desktop.url})\n![Mobile](${mobile.url})`;
  let filename = "packages/ui/src/styles/workflow.css";
  const api = async <T>(path: string): Promise<T> =>
    (path.includes("/files?") ? [{ filename, status: "modified" }] : { head: { sha: head }, body }) as T;
  const candidate = { number: 1, headSha: head, branch: "branch", url: "url" };
  const published = [desktop, mobile];
  assert.deepEqual((await demoStatus(api, "org/repo", candidate, runId, published)).missing, []);
  body = `## Demo\n![Desktop](${desktop.url})`;
  assert.deepEqual((await demoStatus(api, "org/repo", candidate, runId, published)).missing, ["mobile"]);
  body = `## Verification\n![Desktop](${desktop.url})\n![Mobile](${mobile.url})`;
  assert.deepEqual((await demoStatus(api, "org/repo", candidate, runId, published)).missing, ["Demo section", "desktop", "mobile"]);
  body = `## Demo\n${desktop.url}\n${mobile.url}`;
  assert.equal((await demoStatus(api, "org/repo", candidate, runId, published)).status, "needs-attention", "links are not displayed images");
  body = `## Demo\n![Desktop](${desktop.url})\n![Mobile](${mobile.url})`;
  assert.equal((await demoStatus(api, "org/repo", candidate, "22222222-2222-4222-8222-222222222222", published)).status, "needs-attention",
    "another run's images do not count");
  await assert.rejects(demoStatus(api, "org/repo", { ...candidate, headSha: "b".repeat(40) }, runId, published), status(409));
  filename = "docs/evidence/demo.png";
  await assert.rejects(demoStatus(api, "org/repo", candidate, runId, published), status(422));
  filename = "src/lib/server.ts";
  assert.equal((await demoStatus(api, "org/repo", candidate, runId, [])).status, "not-required");
});

test("Demo examples and data-src placeholders cannot count as displayed images", () => {
  const { url } = receipt("desktop.png");
  assert.equal(demoImageKeys(`![Desktop](${url})\n<img src="${url}" />`, runId).size, 1);
  for (const text of [`<img data-src="${url}" />`, `<!-- ![Desktop](${url}) -->`, `\`\`\`md\n![Desktop](${url})\n\`\`\``,
    `\`![Desktop](${url})\``, `    ![Desktop](${url})`, `<img title=' src="${url}"'>`])
    assert.equal(demoImageKeys(text, runId).size, 0, text);
});


test("viewport labels accept named captures but identical pixels need review", async () => {
  const desktop = receipt("split-desktop.png"), mobile = receipt("split-mobile.png");
  const candidate = { number: 1, headSha: head, branch: "branch", url: "url" };
  const api = async <T>(path: string): Promise<T> => (path.includes("/files?")
    ? [{filename:"examples/split/index.html",status:"added"}]
    : {head:{sha:head},body:`## Demo\n![Desktop](${desktop.url})\n![Mobile](${mobile.url})`}) as T;
  assert.equal((await demoStatus(api,"org/repo",candidate,runId,[desktop,mobile])).status,"complete");
  mobile.sha256 = desktop.sha256;
  mobile.url = `${origin}/files/main/runs/${evidenceKey(runId,head,mobile.sha256,mobile.filename)}`;
  assert.deepEqual((await demoStatus(api,"org/repo",candidate,runId,[desktop,mobile])).missing,["distinct desktop/mobile captures"]);
});
