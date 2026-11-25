import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const route = "/api/apps/software-foundry/jobs";
const installationId = "fixture-foundry";
const orgId = "fixture-org";
const script = "fixture-foundry-script";

export function configureFoundryDispatch() {
  process.env.APP_SERVER_ENTRIES = JSON.stringify({
    [script]: fileURLToPath(new URL("./foundry-dispatch.mjs", import.meta.url)),
  });
}

export async function installFoundryJob({ load, db, job }) {
  const root = join(process.env.FOUNDRY_EVAL_APPS_CHECKOUT, "apps/software-foundry");
  const { appInstallations } = await load("src/db/schema.ts");
  const { parse } = await load("node_modules/yaml/dist/index.js");
  const manifest = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
  const workflow = readFileSync(join(root, "workflows", job, "workflow.yaml"), "utf8");
  const definition = parse(workflow);
  const { name: packageName, version } = JSON.parse(
    readFileSync(join(root, "workflows", job, "package.json"), "utf8"),
  );
  const capabilities = manifest.modes.operational.capabilities;
  assert.ok(capabilities.includes("workflow.host"));
  assert.ok(capabilities.includes(`workflow.${job}.start`));
  const packageHash = createHash("sha256").update(workflow).digest("hex");
  const target = { id: installationId, script, hostname: "fixture-foundry.fixture-team.localhost", packageHash, capabilities };
  await db.insert(appInstallations).values({
    id: target.id,
    organizationId: orgId,
    template: "software-foundry",
    hostname: target.hostname,
    activeScript: script,
    activeHash: packageHash,
    mode: "operational",
    capabilities,
    workflowPackages: [{ package: packageName, version, definition }],
    createdAt: 1,
  });
  return target;
}

export async function runFoundryAudit({ load, db, target, request, job, repository, slot }) {
  const { authenticated } = await load("src/lib/auth.ts");
  const { appRequest } = await load("src/lib/app-requests.ts");
  const { loadRun } = await load("src/lib/workflow-runs.ts");
  const service = await authenticated(request);
  assert.equal(service.tenant.kind, "organization");
  assert.equal(service.tenant.organization.id, orgId);
  const response = await appRequest(
    target,
    { userId: service.user.id, organizationId: orgId, role: "owner" },
    route,
    { method: "POST", contentType: "application/json", body: JSON.stringify({ action: "run", job, repository }) },
  );
  assert.equal(response.status, 202, await response.clone().text());
  const receipt = await response.json();
  assert.equal(receipt.job, job);
  assert.equal(receipt.repository, repository);
  const { run, state } = await loadRun(db, receipt.run);
  assert.equal(run.workflowId, job);
  assert.equal(run.installationId, target.id);
  assert.equal(run.organizationId, orgId);
  assert.equal(run.createdBy, service.user.id);
  assert.equal(run.status, "complete");
  assert.equal(state.inputs["check.inputs.repository"], repository);
  assert.equal(state.rows[slot]?.complete, true);
  const result = state.rows[slot]?.value;
  assert.ok(result, `Missing persisted workflow result at ${slot}`);
  const { GET } = await load("src/pages/api/workflow-runs/[id].ts");
  const read = await GET({
    request: new Request(new URL(`/api/workflow-runs/${receipt.run}`, request.url), { headers: request.headers }),
    params: { id: receipt.run },
  });
  assert.equal(read.status, 200, await read.clone().text());
  const view = await read.json();
  assert.equal(view.id, receipt.run);
  assert.equal(view.status, "complete");
  assert.deepEqual(view.rows[slot], { value: result, complete: true });
  assert.deepEqual(view.attempts, []);
  return { result, receipt, slot, route };
}
