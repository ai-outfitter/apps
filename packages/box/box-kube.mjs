#!/usr/bin/env node
// box-kube: the small slice of the Kubernetes API that the workspace gateway
// uses, for the sealed Foundry box. It stores objects in memory (and in a JSON
// file when BOX_KUBE_STATE is set) and runs each Workspace as a local
// workspace/runtime process instead of a Pod. It also proxies
// /runtime/<namespace>/<workspace>/... to that process, so the gateway reaches
// runtimes through WORKSPACE_RUNTIME_ORIGIN.
//
// Not a general Kubernetes: no watches, no label selectors, no auth. It listens
// on loopback only and is reachable only from inside the box.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Pure object store with Kubernetes create/get/merge-patch/put/delete semantics. */
export class Store {
  constructor(objects = {}) {
    this.objects = objects;
    this.version = Object.values(objects).reduce((max, o) => Math.max(max, Number(o.metadata?.resourceVersion) || 0), 0);
  }
  #stamp(object) {
    object.metadata.resourceVersion = String(++this.version);
    return object;
  }
  get(key) {
    return this.objects[key];
  }
  create(key, object, namespace) {
    if (!object?.metadata?.name) throw status(422, "metadata.name is required");
    if (this.objects[key]) throw status(409, "AlreadyExists");
    const created = structuredClone(object);
    created.metadata = {
      ...created.metadata,
      ...(namespace ? { namespace } : {}),
      uid: randomUUID(),
      generation: 1,
      creationTimestamp: new Date().toISOString(),
    };
    this.objects[key] = this.#stamp(created);
    return created;
  }
  patch(key, patch) {
    const current = this.objects[key];
    if (!current) throw status(404, "NotFound");
    const expected = patch?.metadata?.resourceVersion;
    if (expected && expected !== current.metadata.resourceVersion) throw status(409, "Conflict");
    const { resourceVersion: _ignored, ...metadata } = patch.metadata ?? {};
    const next = mergePatch(current, { ...patch, metadata });
    if (patch.spec !== undefined && JSON.stringify(next.spec) !== JSON.stringify(current.spec))
      next.metadata.generation = (current.metadata.generation ?? 1) + 1;
    this.objects[key] = this.#stamp(next);
    return next;
  }
  put(key, object, namespace) {
    const current = this.objects[key];
    if (!current) return this.create(key, object, namespace);
    const next = { ...structuredClone(object), metadata: { ...current.metadata, ...object.metadata, uid: current.metadata.uid } };
    this.objects[key] = this.#stamp(next);
    return next;
  }
  delete(key) {
    const current = this.objects[key];
    if (!current) throw status(404, "NotFound");
    delete this.objects[key];
    return current;
  }
  list(prefix) {
    return Object.entries(this.objects).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
  }
}

/** RFC 7386 JSON merge patch. */
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const result = target && typeof target === "object" && !Array.isArray(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function status(code, reason) {
  return Object.assign(new Error(reason), { status: code });
}

/**
 * Maps a request path to a store key and collection prefix. Only the resources
 * the gateway uses are routed; anything else is a 404.
 */
export function route(path) {
  let match = path.match(/^\/api\/v1\/namespaces(?:\/([a-z0-9-]+))?$/);
  if (match) return { kind: "Namespace", collection: "ns/", key: match[1] && `ns/${match[1]}` };
  match = path.match(/^\/api\/v1\/namespaces\/([a-z0-9-]+)\/(secrets|resourcequotas|pods)(?:\/([a-z0-9.-]+))?(\/resize)?$/);
  if (match) {
    const [, namespace, resource, name, resize] = match;
    return { namespace, resource, resize: Boolean(resize), collection: `${resource}/${namespace}/`, key: name && `${resource}/${namespace}/${name}` };
  }
  match = path.match(/^\/apis\/aioutfitter\.com\/v1alpha1\/namespaces\/([a-z0-9-]+)\/workspaces(?:\/([a-z0-9-]+))?$/);
  if (match) {
    const [, namespace, name] = match;
    return { namespace, resource: "workspaces", collection: `workspaces/${namespace}/`, key: name && `workspaces/${namespace}/${name}` };
  }
  return null;
}

/** Runs one runtime process per awake Workspace and reports its status like the operator does. */
export class Controller {
  /**
   * @typedef {{ on(event: string, listener: (...args: any[]) => void): unknown, kill(signal?: string): unknown, killed?: boolean }} RuntimeProcess
   * @param {{ store: any, runtimeScript: string, dataDirectory: string, gatewayUrl: string, model?: string,
   *   spawnRuntime?: (script: string, env: Record<string, string>) => RuntimeProcess,
   *   freePort?: () => Promise<number>, log?: (...args: any[]) => void }} options
   */
  constructor({ store, runtimeScript, dataDirectory, gatewayUrl, model, spawnRuntime = defaultSpawn, freePort = findFreePort, log = console.error }) {
    Object.assign(this, { store, runtimeScript, dataDirectory, gatewayUrl, model, spawnRuntime, freePort, log });
    this.processes = new Map();
  }
  async reconcile(now = Date.now()) {
    for (const workspace of this.store.list("workspaces/")) {
      try {
        await this.#reconcileOne(workspace, now);
      } catch (error) {
        this.log("box-kube: workspace reconcile failed", workspace.metadata.name, error.message);
      }
    }
  }
  async #reconcileOne(workspace, now) {
    const { name, namespace } = workspace.metadata;
    const key = `workspaces/${namespace}/${name}`;
    const awake = Date.parse(workspace.spec.awakeUntil) > now && Date.parse(workspace.spec.expiresAt) > now;
    const generation = workspace.spec.computeGeneration ?? 1;
    const running = this.processes.get(key);
    if (!awake) {
      if (running) this.#stop(key);
      return this.#report(key, "Sleeping", undefined, generation);
    }
    // A spec change that keeps the compute generation (a renewed awakeUntil)
    // is observed without restarting the runtime, as the operator does.
    if (running && running.generation === generation && !running.exited) return this.#report(key, "Running", running.podName, generation);
    if (running?.exited && running.generation === generation) return this.#report(key, "Interrupted", undefined, generation);
    if (running) this.#stop(key);
    const secret = this.store.get(`secrets/${namespace}/${workspace.spec.credentialSecretName}`);
    const token = secret?.stringData?.token;
    if (!token) return this.#report(key, "Starting", undefined, generation);
    const port = await this.freePort();
    const root = join(this.dataDirectory, namespace, name);
    mkdirSync(root, { recursive: true });
    const podName = `${name}-g${generation}`;
    const child = this.spawnRuntime(this.runtimeScript, {
      PORT: String(port),
      WORKSPACE_TOKEN: token,
      WORKSPACE_ROOT: root,
      INFERENCE_BASE_URL: `${this.gatewayUrl}/inference/${name}/v1`,
      ...(this.model ? { AI_MODEL: this.model } : {}),
    });
    const entry = { child, port, generation, podName, exited: false };
    child.on?.("exit", () => {
      entry.exited = true;
    });
    this.processes.set(key, entry);
    this.store.put(`pods/${namespace}/${podName}`, pod(name, podName), namespace);
    this.#report(key, "Running", podName, generation);
  }
  #report(key, reason, podName, generation) {
    const workspace = this.store.get(key);
    if (!workspace) return;
    const conditions = [{ type: "Ready", status: reason === "Running" ? "True" : "False", reason }];
    const current = workspace.status ?? {};
    if (current.podName === podName && current.conditions?.[0]?.reason === reason && current.computeGeneration === generation
      && current.observedGeneration === workspace.metadata.generation) return;
    workspace.status = { ...current, conditions, computeGeneration: generation, observedGeneration: workspace.metadata.generation, ...(podName ? { podName } : {}) };
    if (!podName) delete workspace.status.podName;
  }
  #stop(key) {
    const entry = this.processes.get(key);
    this.processes.delete(key);
    entry?.child.kill?.("SIGTERM");
  }
  /** The local port serving a workspace's runtime, if it is running. */
  port(namespace, name) {
    const entry = this.processes.get(`workspaces/${namespace}/${name}`);
    return entry && !entry.exited ? entry.port : undefined;
  }
  stopAll() {
    for (const key of [...this.processes.keys()]) this.#stop(key);
  }
}

function pod(workspace, name) {
  // Box runtimes share the box's resources, so they report the gateway's
  // largest capacity ask as already granted.
  const resources = { requests: { cpu: "500m", memory: "2Gi" }, limits: { cpu: "4", memory: "8Gi" } };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, labels: { "aioutfitter.com/workspace": workspace, "aioutfitter.com/workload": "workspace" } },
    spec: { containers: [{ name: "runtime", resources }] },
    status: { phase: "Running", containerStatuses: [{ name: "runtime", resources }], conditions: [] },
  };
}

function defaultSpawn(script, env) {
  return spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: "inherit" });
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw status(413, "Too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw status(400, "Invalid JSON");
  }
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Requests outside the object store: discovery and token reviews. */
function special(method, path) {
  if (method === "GET" && path === "/.well-known/openid-configuration")
    return [200, { issuer: "https://box-kube.local", jwks_uri: "https://box-kube.local/openid/v1/jwks" }];
  if (method === "POST" && path === "/apis/authentication.k8s.io/v1/tokenreviews")
    // The box has no service-account tokens; identity inference is not offered.
    return [201, { apiVersion: "authentication.k8s.io/v1", kind: "TokenReview", status: { authenticated: false } }];
  return null;
}

/** One named object: get, resize, merge patch, replace or delete. */
function handleObject(store, method, target, body) {
  if (method === "GET" || (target.resize && method === "PATCH")) {
    const object = store.get(target.key);
    return object ? [200, object] : [404, { reason: "NotFound" }];
  }
  if (method === "PATCH") return [200, store.patch(target.key, body ?? {})];
  if (method === "PUT") return [200, store.put(target.key, body, target.namespace)];
  if (method === "DELETE") return [200, store.delete(target.key)];
  return [405, { reason: "MethodNotAllowed" }];
}

/** Handles one Kubernetes API request against the store. */
export async function handleKube(store, method, path, body) {
  const answer = special(method, path);
  if (answer) return answer;
  const target = route(path);
  if (!target) return [404, { reason: "NotFound" }];
  if (target.key) return handleObject(store, method, target, body);
  if (method === "POST") return [201, store.create(`${target.collection}${body?.metadata?.name}`, body, target.namespace)];
  return [200, { items: store.list(target.collection) }];
}

function proxy(req, res, port, path) {
  const upstream = http.request(
    { host: "127.0.0.1", port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => send(res, 502, { error: "Workspace runtime unavailable" }));
  req.pipe(upstream);
}

async function apiRequest(req, res, url, { store, controller, persist }) {
  try {
    const body = ["POST", "PATCH", "PUT"].includes(req.method ?? "") ? await readBody(req) : undefined;
    const [code, result] = await handleKube(store, req.method ?? "GET", url.pathname, body);
    if (code < 300 && req.method !== "GET") {
      await controller.reconcile();
      persist?.();
    }
    send(res, code, result);
  } catch (error) {
    send(res, error.status || 500, { reason: error.message });
  }
}

export function createBoxKube(context) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://box-kube");
    const runtime = url.pathname.match(/^\/runtime\/([a-z0-9-]+)\/([a-z0-9-]+)(\/.*)$/);
    if (!runtime) return apiRequest(req, res, url, context);
    const port = context.controller.port(runtime[1], runtime[2]);
    if (!port) return send(res, 503, { error: "Workspace runtime is not running" });
    return proxy(req, res, port, `${runtime[3]}${url.search}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const statePath = process.env.BOX_KUBE_STATE;
  const store = new Store(statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});
  const persist = statePath ? () => writeFileSync(statePath, JSON.stringify(store.objects)) : undefined;
  const dataDirectory = process.env.BOX_WORKSPACES_DIR || "/box/workspaces";
  mkdirSync(dataDirectory, { recursive: true });
  const controller = new Controller({
    store,
    runtimeScript: process.env.BOX_RUNTIME_SCRIPT || "/opt/workspace/server.mjs",
    dataDirectory,
    gatewayUrl: process.env.BOX_GATEWAY_URL || "http://127.0.0.1:4040",
    model: process.env.AI_MODEL,
  });
  const server = createBoxKube({ store, controller, persist });
  const timer = setInterval(() => controller.reconcile().then(() => persist?.()), 2000);
  const port = Number(process.env.BOX_KUBE_PORT || 7070);
  server.listen(port, "127.0.0.1", () => console.error(`box-kube listening on 127.0.0.1:${port}`));
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      clearInterval(timer);
      controller.stopAll();
      server.close(() => process.exit(0));
    });
}
