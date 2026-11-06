import assert from "node:assert/strict";
import test from "node:test";
import {
  mountThreadPath, parseThreadParts, parseThreadRefKey, stableThreadId, threadClient, threadOperations, threadProvider,
  threadRefKey, threadTypeDescriptor,
} from "../src/threads";
import { operations, operationAllowed } from "../src/workflow-host";

test("thread refs round-trip through their string keys, including provider history refs", () => {
  const stored = { id: "11111111-1111-4111-8111-111111111111" };
  const history = { installationId: "provider-1", type: "flow.workflow-run", sourceId: "run/1:a" };
  assert.deepEqual(parseThreadRefKey(threadRefKey(stored)), stored);
  assert.deepEqual(parseThreadRefKey(threadRefKey(history)), history);
  assert.equal(parseThreadRefKey("not-a-uuid"), undefined);
});

test("unknown or malformed parts fall back to structured data instead of being dropped", () => {
  assert.deepEqual(parseThreadParts([{ type: "text", text: "hi" }, { type: "chart", points: [1] }, "loose"]), [
    { type: "text", text: "hi" },
    { type: "data", name: "unknown", data: { type: "chart", points: [1] } },
    { type: "data", name: "unknown", data: "loose" },
  ]);
  assert.deepEqual(parseThreadParts(null), []);
});

test("history types are read-only by declaration", () => {
  assert.equal(threadTypeDescriptor.safeParse({ type: "flow.run", label: "Runs", kind: "history", operations: ["list", "entries"] }).success, true);
  assert.equal(threadTypeDescriptor.safeParse({ type: "flow.run", label: "Runs", kind: "history", operations: ["list", "send"] }).success, false);
  assert.equal(threadTypeDescriptor.safeParse({ type: "unnamespaced", label: "X", kind: "conversation", operations: ["send"] }).success, false);
});

test("thread operations are composed into the workflow host and never reach an invocation", () => {
  for (const name of Object.keys(threadOperations)) {
    assert.ok(Object.hasOwn(operations, name), name);
    assert.equal(operationAllowed(name, "interactive"), true);
    assert.equal(operationAllowed(name, "invocation"), false);
    assert.equal(operationAllowed(name, "finalize"), false);
  }
  assert.equal(threadOperations["threads.send"].input.safeParse({ threadId: crypto.randomUUID(), submissionId: crypto.randomUUID(), text: " " }).success, false,
    "a message or attachment is required");
  const big = { draft: "x".repeat(140 * 1024) };
  assert.equal(threadOperations["threads.send"].input.safeParse({ threadId: crypto.randomUUID(), submissionId: crypto.randomUUID(), text: "hi", metadata: big }).success, false,
    "metadata is bounded");
});

test("the provider handler validates callbacks both ways and refuses unknown ones", async () => {
  const handler = threadProvider({
    types: () => [{ type: "app.conversation", version: 1, label: "App", kind: "conversation", operations: ["create", "send"] }],
    async prepare() { return { instructions: "Be brief", history: { limit: 5 }, maxSteps: 16 }; },
  });
  const post = (operation: string, body: unknown) => handler(new Request(`https://app.test/api/internal/threads/v1/${operation}`, { method: "POST", body: JSON.stringify(body) }), operation);
  assert.equal((await post("types", {})).status, 200);
  assert.equal((await post("unknown", {})).status, 404);
  assert.equal((await post("tool", { thread: {} })).status, 400, "invalid callback input");
  assert.equal((await post("entries", { type: "app.conversation", sourceId: "s", limit: 1 })).status, 404, "unimplemented callback");
  const get = await handler(new Request("https://app.test/api/internal/threads/v1/types"), "types");
  assert.equal(get.status, 404, "callbacks are POST only");
});

test("stable thread ids are deterministic UUIDs per namespace and parts", async () => {
  const one = await stableThreadId("chat.timeline", "org", "project");
  assert.equal(one, await stableThreadId("chat.timeline", "org", "project"));
  assert.notEqual(one, await stableThreadId("chat.timeline", "org", "other"));
  assert.match(one, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("thread paths are rebased onto the page's mount with its installation", async () => {
  assert.equal(mountThreadPath("/api/platform/threads/t/attachments/a", "/o/acme/planning/api/platform/threads"), "/o/acme/planning/api/platform/threads/t/attachments/a");
  assert.equal(mountThreadPath("/api/platform/threads/t/attachments/a", "/api/platform/threads", "inst"), "/api/platform/threads/t/attachments/a?installation=inst");
  assert.equal(mountThreadPath("https://elsewhere.test/x", "/o/acme/api/platform/threads"), "https://elsewhere.test/x");
  const seen: string[] = [];
  const client = threadClient({ base: "/apps/inst/api/platform/threads", fetch: (async (url: string) => {
    seen.push(url);
    return Response.json({ entries: [{ id: "e", thread: { id: "t" }, role: "user", status: "complete", submissionId: null, sourceKey: null, metadata: null, createdAt: 1, recordedAt: null,
      attribution: { actor: { kind: "member", id: "u" }, origin: { kind: "member", id: "u" }, userId: "u", installationId: null },
      parts: [{ type: "file", attachmentId: "a", filename: "a.png", mediaType: "image/png", url: "/api/platform/threads/t/attachments/a" }] }], before: null, after: null });
  }) as typeof fetch });
  const page = await client.entries("t", { limit: 5 });
  assert.equal(seen[0], "/apps/inst/api/platform/threads/t/entries?limit=5");
  assert.equal((page.entries[0].parts[0] as { url: string }).url, "/apps/inst/api/platform/threads/t/attachments/a");
});

test("each per-domain operation map loads first in a cold process without an import cycle", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const first of ["./src/platform-records.ts", "./src/threads.ts", "./src/host-operation.ts"]) {
    const script = `const a = await import(${JSON.stringify(first)}); const { operations } = await import("./src/workflow-host.ts");
      if (!operations["threads.send"] || !operations["workflow.read"]) throw new Error("registry incomplete"); console.log(Object.keys(a).length > 0);`;
    const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(run.status, 0, `${first}: ${run.stderr}`);
  }
});

test("schema descriptors are namespaced, versioned, bounded and travel in threads.types", async () => {
  const { partSchema, threadSchemaDescriptor } = await import("../src/threads");
  const base = { type: "acme.conversation", label: "Acme", kind: "conversation", operations: ["send"], parts: ["acme.card"] };
  const card = (version: number) => ({ name: "acme.card", version, kind: "part", schema: { type: "object" } });
  assert.equal(threadTypeDescriptor.safeParse({ ...base, schemas: [card(1), card(2)] }).success, true);
  assert.equal(threadTypeDescriptor.safeParse({ ...base, schemas: [card(1), card(1)] }).success, false, "one name+version per kind");
  assert.equal(threadTypeDescriptor.safeParse({ ...base, schemas: [{ ...card(1), name: "acme.other" }] }).success, false, "a part schema names a declared part");
  assert.equal(threadSchemaDescriptor.safeParse({ ...card(1), name: "unnamespaced" }).success, false);
  assert.equal(threadSchemaDescriptor.safeParse({ ...card(1), schema: { big: "x".repeat(17 * 1024) } }).success, false);
  const out = threadOperations["threads.types"].output.parse([{ ...base, schemas: [card(1), card(3)], installationId: "app" }]);
  assert.deepEqual(out[0].schemas?.map((schema) => schema.version), [1, 3]);
  assert.equal(partSchema(out[0].schemas, "acme.card", 1)?.version, 1);
  assert.equal(partSchema(out[0].schemas, "acme.card")?.version, 3, "newest when the part names no known version");
  assert.equal(partSchema(out[0].schemas, "acme.none"), undefined);
});
