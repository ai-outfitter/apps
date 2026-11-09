import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Controller, createBoxKube, handleKube, mergePatch, route, Store } from "../box-kube.mjs";

const workspacePath = (ns: string, id = "") => `/apis/aioutfitter.com/v1alpha1/namespaces/${ns}/workspaces${id ? `/${id}` : ""}`;
const hour = 3600_000;

function workspace(name: string, awake = Date.now() + hour) {
  return {
    apiVersion: "aioutfitter.com/v1alpha1",
    kind: "Workspace",
    metadata: { name },
    spec: { credentialSecretName: name, awakeUntil: new Date(awake).toISOString(), expiresAt: new Date(Date.now() + 2 * hour).toISOString(), storagePolicy: "reusable", computeGeneration: 1 },
  };
}

function fakeController(store: Store) {
  const spawned: { env: Record<string, string>; child: EventEmitter & { kill(): void; killed?: boolean } }[] = [];
  let port = 40000;
  const controller = new Controller({
    store,
    runtimeScript: "/opt/workspace/server.mjs",
    dataDirectory: "/tmp/box-kube-test",
    gatewayUrl: "http://127.0.0.1:4040",
    model: "GLM-5.3-Flash-EXL3",
    freePort: async () => ++port,
    spawnRuntime: (_script: string, env: Record<string, string>) => {
      const child: EventEmitter & { kill(): void; killed?: boolean } = Object.assign(new EventEmitter(), {
        kill() {
          child.killed = true;
        },
      });
      spawned.push({ env, child });
      return child;
    },
  });
  return { controller, spawned };
}

test("a runtime's WORKSPACE_ROOT is a short link to its workspace directory", async () => {
  const store = new Store();
  const { controller, spawned } = fakeController(store);
  const [namespace, name] = ["outfitter-t-bc9822e9da2259c8178b", "ws-13040ac9-cd1b-4c96-9dfc-e6c3503e2ef9"];
  await handleKube(store, "POST", workspacePath(namespace), workspace(name));
  await handleKube(store, "POST", `/api/v1/namespaces/${namespace}/secrets`, { metadata: { name }, stringData: { token: "t".repeat(40) } });
  await controller.reconcile();
  await controller.reconcile();
  const root = spawned[0].env.WORKSPACE_ROOT;
  assert.equal(realpathSync(root), "/tmp/box-kube-test/outfitter-t-bc9822e9da2259c8178b/ws-13040ac9-cd1b-4c96-9dfc-e6c3503e2ef9");
  // Chrome's profile directory and sockets live under <root>/tmp; production's is /workspace/tmp.
  assert.ok(`${root}/tmp`.length <= 48, root);
  controller.stopAll();
  assert.throws(() => realpathSync(root), "a stopped runtime's link is removed");
});

test("routes only the resources the gateway uses", () => {
  assert.equal(route("/api/v1/namespaces/ws-a")?.key, "ns/ws-a");
  assert.equal(route("/api/v1/namespaces/ws-a/secrets/x")?.key, "secrets/ws-a/x");
  assert.equal(route("/api/v1/namespaces/ws-a/pods/p-g1/resize")?.resize, true);
  assert.equal(route(workspacePath("ws-a", "w1"))?.key, "workspaces/ws-a/w1");
  assert.equal(route("/api/v1/namespaces/ws-a/configmaps/x"), null);
});

test("create is once, then conflicts; merge patch bumps generation only on spec change", async () => {
  const store = new Store();
  const [code, created] = await handleKube(store, "POST", workspacePath("ws-a"), workspace("w1"));
  assert.equal(code, 201);
  assert.equal(created.metadata.generation, 1);
  await assert.rejects(handleKube(store, "POST", workspacePath("ws-a"), workspace("w1")), { status: 409 });
  const [, patched] = await handleKube(store, "PATCH", workspacePath("ws-a", "w1"), {
    metadata: { resourceVersion: created.metadata.resourceVersion },
    spec: { computeGeneration: 2 },
  });
  assert.equal(patched.metadata.generation, 2);
  assert.equal(patched.spec.storagePolicy, "reusable");
  await assert.rejects(handleKube(store, "PATCH", workspacePath("ws-a", "w1"), { metadata: { resourceVersion: created.metadata.resourceVersion }, spec: {} }), { status: 409 });
  assert.deepEqual(mergePatch({ a: 1, b: { c: 2 } }, { b: { c: null, d: 3 } }), { a: 1, b: { d: 3 } });
});

test("an awake workspace with its secret gets one runtime process and reports Running", async () => {
  const store = new Store();
  const { controller, spawned } = fakeController(store);
  await handleKube(store, "POST", workspacePath("ws-a"), workspace("w1"));
  await controller.reconcile();
  assert.equal(spawned.length, 0, "no token yet");
  assert.equal(store.get("workspaces/ws-a/w1").status.conditions[0].reason, "Starting");
  await handleKube(store, "POST", "/api/v1/namespaces/ws-a/secrets", { metadata: { name: "w1" }, stringData: { token: "t".repeat(40) } });
  await controller.reconcile();
  await controller.reconcile();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].env.WORKSPACE_TOKEN, "t".repeat(40));
  assert.equal(spawned[0].env.INFERENCE_BASE_URL, "http://127.0.0.1:4040/inference/w1/v1");
  const status = store.get("workspaces/ws-a/w1").status;
  assert.deepEqual([status.conditions[0].reason, status.podName, status.observedGeneration], ["Running", "w1-g1", 1]);
  // Renewing awakeUntil bumps the generation; it is observed without a restart.
  const current = store.get("workspaces/ws-a/w1");
  store.patch("workspaces/ws-a/w1", { metadata: { resourceVersion: current.metadata.resourceVersion }, spec: { awakeUntil: new Date(Date.now() + 2 * hour).toISOString() } });
  await controller.reconcile();
  assert.equal(spawned.length, 1);
  assert.equal(store.get("workspaces/ws-a/w1").status.observedGeneration, 2);
  const [, pod] = await handleKube(store, "GET", "/api/v1/namespaces/ws-a/pods/w1-g1");
  assert.equal(pod.metadata.labels["aioutfitter.com/workspace"], "w1");
  assert.equal(pod.status.phase, "Running");
});

test("sleep stops the runtime, a new compute generation restarts it, and a crash is Interrupted", async () => {
  const store = new Store();
  const { controller, spawned } = fakeController(store);
  await handleKube(store, "POST", workspacePath("ws-a"), workspace("w1"));
  await handleKube(store, "POST", "/api/v1/namespaces/ws-a/secrets", { metadata: { name: "w1" }, stringData: { token: "t".repeat(40) } });
  await controller.reconcile();
  await controller.reconcile(Date.now() + 1.5 * hour);
  assert.equal(spawned[0].child.killed, true);
  assert.equal(store.get("workspaces/ws-a/w1").status.conditions[0].reason, "Sleeping");
  assert.equal(store.get("workspaces/ws-a/w1").status.podName, undefined);
  const current = store.get("workspaces/ws-a/w1");
  store.patch("workspaces/ws-a/w1", { metadata: { resourceVersion: current.metadata.resourceVersion }, spec: { computeGeneration: 2, awakeUntil: new Date(Date.now() + hour).toISOString() } });
  await controller.reconcile();
  assert.equal(spawned.length, 2);
  assert.equal(store.get("workspaces/ws-a/w1").status.podName, "w1-g2");
  spawned[1].child.emit("exit", 1);
  await controller.reconcile();
  assert.equal(store.get("workspaces/ws-a/w1").status.conditions[0].reason, "Interrupted");
});

test("proxies /runtime/<namespace>/<id>/ to the workspace's runtime process", async (t) => {
  const runtime = http.createServer((req, res) => res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization })));
  await new Promise<void>((done) => runtime.listen(0, "127.0.0.1", done));
  const runtimePort = (runtime.address() as AddressInfo).port;
  const store = new Store();
  const { controller } = fakeController(store);
  Object.assign(controller, { freePort: async () => runtimePort });
  const box = createBoxKube({ store, controller });
  await new Promise<void>((done) => box.listen(0, "127.0.0.1", done));
  t.after(() => { box.close(); runtime.close(); });
  const origin = `http://127.0.0.1:${(box.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST", body: JSON.stringify(body) });
  assert.equal((await fetch(`${origin}/runtime/ws-a/w1/health`)).status, 503);
  assert.equal((await post(workspacePath("ws-a"), workspace("w1"))).status, 201);
  assert.equal((await post("/api/v1/namespaces/ws-a/secrets", { metadata: { name: "w1" }, stringData: { token: "t".repeat(40) } })).status, 201);
  const response = await fetch(`${origin}/runtime/ws-a/w1/runs/1?x=1`, { headers: { Authorization: "Bearer abc" } });
  assert.deepEqual(await response.json(), { path: "/runs/1?x=1", auth: "Bearer abc" });
});
