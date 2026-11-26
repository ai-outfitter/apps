import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { relay } from "./relay.mjs";
import { provider } from "./provider.mjs";
import { decoy, resolve } from "./resolution.mjs";

const generated = "/app/src/generated/apps";
const app = "software-foundry";
copyFileSync(`/package/${app}.operational.json`, `${generated}/${app}.operational.json`);
for (const [index, name] of [["graph-schemas.json", "schema.graphql"], ["graph-documents.json", "documents.json"]]) {
  const path = `${generated}/${index}`;
  const all = JSON.parse(readFileSync(path, "utf8"));
  const input = readFileSync(`/package/${name}`, "utf8");
  all[app] = name.endsWith(".json") ? JSON.parse(input) : input;
  writeFileSync(path, JSON.stringify(all));
}

const servers = [[relay, 3300], [provider, 3303], [decoy, 3304], [resolve, 3305]].map(([handler, port]) => {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
  });
  return [server, port];
});
for (const [server, port] of servers) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
}
// The box shim launches the runtime directly. Mirror the production runtime's
// inspector setting for images whose runtime declares it.
const isolatedRuntime = readFileSync("/opt/workspace/server.mjs", "utf8").includes("forgejoIsolatedCheckout: true");
const authorityRoute = existsSync("/app/src/pages/api/internal/workspace-review-authority.ts");
const nodeOptions = [
  isolatedRuntime && "--disable-sigusr1",
  authorityRoute && "--import=/eval/authority-observer.mjs",
].filter(Boolean).join(" ");
const child = spawn(process.execPath, ["/app/.box/box/supervisor.mjs"], {
  env: {
    ...process.env,
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    ASTRO_TELEMETRY_DISABLED: "1", SPARK_BASE_URL: "http://127.0.0.1:3303/v1",
    SPARK_AUTHORIZATION: "Bearer isolated-box", AI_MODEL: "GLM-5.3-Flash-EXL3",
    OPENAI_API_KEY: "fixture-decoy-unused", OPENAI_BASE_URL: "http://127.0.0.1:3304/v1",
    WORKSPACE_RESOLVE_URL: "http://127.0.0.1:3305/resolve",
    BOX_REPO_NAME: "review-fixture", BOX_DRIVER: "/eval/driver.mjs", BOX_EXIT_WHEN_DONE: "1",
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
