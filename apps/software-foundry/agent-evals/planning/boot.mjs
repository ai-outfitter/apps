import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anchor } from "./box-fixture.mjs";
import { startInferenceFixture } from "./inference-fixture.mjs";
import { startForgejoRelay } from "./forgejo-relay.mjs";

const supervisor = "/app/.box/box/supervisor.mjs";
const generated = "/app/src/generated/apps";
const app = "software-foundry";

copyFileSync("/package/software-foundry.operational.json", join(generated, `${app}.operational.json`));
for (const [file, source, parse] of [
  ["graph-schemas.json", "schema.graphql", false],
  ["graph-documents.json", "documents.json", true],
]) {
  const path = join(generated, file);
  const all = JSON.parse(readFileSync(path, "utf8"));
  const replacement = readFileSync(`/package/${source}`, "utf8");
  all[app] = parse ? JSON.parse(replacement) : replacement;
  writeFileSync(path, JSON.stringify(all));
}

copyFileSync("/eval/fixtures/webhook-route.ts.fixture", "/app/src/pages/api/webhooks/foundry-planning-eval.ts");

const relay = await startForgejoRelay({
  repository: anchor,
  armPath: "/out/drop-next-issue",
  lookupFailurePath: "/out/fail-next-lookup",
  receiptPath: "/out/forgejo-writes.json",
});
const inference = await startInferenceFixture();
const child = spawn(process.execPath, [supervisor], {
  env: {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: "1",
    OPENAI_API_KEY: "local-planning-fixture",
    OPENAI_BASE_URL: "http://127.0.0.1:3303/v1",
    BOX_REPO_NAME: "native-apple",
    BOX_DRIVER: "/eval/driver.mjs",
    BOX_EXIT_WHEN_DONE: "1",
    PATH: `/eval/bin:${process.env.PATH}`,
  },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
const [code] = await once(child, "exit");
for (const server of [relay, inference]) {
  server.closeAllConnections();
  server.close();
}
process.exitCode = code ?? 1;
