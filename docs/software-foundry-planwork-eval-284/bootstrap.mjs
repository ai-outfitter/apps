import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { pipeline } from "node:stream/promises";
import { offlineProvider } from "./provider.mjs";

const app = "software-foundry";
const generated = "/app/src/generated/apps";
const operational = `${generated}/${app}.operational.json`;
if (process.env.PLANWORK_ARM === "short") {
  const pack = JSON.parse(readFileSync(`/package/${app}.operational.json`, "utf8"));
  const plan = pack.manifest.workflows.find(workflow => workflow.definition.id === "foundry-plan-work");
  const step = plan.definition.steps.find(step => step.id === "plan");
  assert.equal(step.inference.timeoutMs, undefined);
  step.inference.timeoutMs = 1500;
  writeFileSync(operational, JSON.stringify(pack));
} else {
  copyFileSync(`/package/${app}.operational.json`, operational);
}
for (const [target, source, json] of [
  ["graph-schemas.json", "schema.graphql", false],
  ["graph-documents.json", "documents.json", true],
]) {
  const path = `${generated}/${target}`;
  const all = JSON.parse(readFileSync(path, "utf8"));
  const content = readFileSync(`/package/${source}`, "utf8");
  all[app] = json ? JSON.parse(content) : content;
  writeFileSync(path, JSON.stringify(all));
}

const publications = [];
const anchor = "box/native-apple";
const mockPath = `/api/v1/repos/${anchor}/issues`;
function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function forgejo(incoming, outgoing) {
  const url = new URL(incoming.url, "http://forgejo.localhost");
  const arm = process.env.PLANWORK_ARM;
  if (url.pathname === mockPath && incoming.method === "GET" && url.searchParams.has("created_by")
      && arm === "uncertainty" && publications.length) {
    assert.equal(url.searchParams.get("created_by"), "outfitter");
    const botId = Number(readFileSync("/out/mock-bot-id.txt", "utf8"));
    assert.ok(Number.isInteger(botId) && botId > 0);
    outgoing.setHeader("x-total-count", String(publications.length));
    return json(outgoing, 200, publications.map(({ issue }) => ({ ...issue, user: { id: botId } })));
  }
  if (url.pathname === mockPath && incoming.method === "POST" && arm === "uncertainty") {
    const { title, body } = JSON.parse(Buffer.concat(await Array.fromAsync(incoming)).toString("utf8"));
    assert.equal(typeof title, "string");
    assert.match(body, /<!-- outfitter:foundry-plan:[a-f0-9-]+ -->/);
    // No issue create or update is forwarded to Forgejo.
    const issue = { number: 1, title, body, state: "open",
      html_url: "http://forgejo.localhost/box/native-apple/issues/1" };
    publications.push({ issue, path: url.pathname, at: new Date().toISOString(), lostResponse: arm === "uncertainty" });
    writeFileSync("/out/mock-publications.json", JSON.stringify(publications, null, 2));
    if (arm === "uncertainty") return json(outgoing, 502, { message: "Controlled lost mock publication response" });
    return json(outgoing, 201, issue);
  }
  if (/^\/api\/v1\/repos\/[^/]+\/[^/]+\/(?:issues|pulls)(?:\/|$)/.test(url.pathname)
      && !["GET", "HEAD"].includes(incoming.method)) {
    writeFileSync("/out/blocked-write.json", JSON.stringify({ method: incoming.method, path: url.pathname }));
    return json(outgoing, 403, { message: "Repository publication blocked" });
  }
  const upstream = request({ host: "127.0.0.1", port: 3301, path: incoming.url, method: incoming.method,
    headers: incoming.headers }, response => {
    outgoing.writeHead(response.statusCode, response.headers);
    void pipeline(response, outgoing).catch(() => {});
  });
  upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502).end(); });
  void pipeline(incoming, upstream).catch(() => upstream.destroy());
}

const servers = [[forgejo, 3300], [offlineProvider(process.env.PLANWORK_ARM), 3303]].map(([handler, port]) => {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) json(res, 502, { message: "Box relay refused request" });
    });
  });
  return [server, port];
});
await Promise.all(servers.map(async ([server, port]) => {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
}));
const child = spawn(process.execPath, ["/app/.box/box/supervisor.mjs"], {
  env: {
    ...process.env, ASTRO_TELEMETRY_DISABLED: "1", SPARK_BASE_URL: "http://127.0.0.1:3303/v1",
    SPARK_AUTHORIZATION: "Bearer isolated-box", AI_MODEL: "GLM-5.3-Flash-EXL3",
    BOX_REPO_NAME: "native-apple", BOX_DRIVER: "/eval/driver.mjs", BOX_EXIT_WHEN_DONE: "1",
    PATH: `/eval/bin:${process.env.PATH}`,
  },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
const [code] = await once(child, "exit");
for (const [server] of servers) {
  server.closeAllConnections();
  server.close();
}
process.exitCode = code ?? 1;
