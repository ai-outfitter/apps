// The Software Foundry's driver for the box (packages/box). The supervisor
// starts the services and the platform with Software Foundry installed, then
// calls run(): configure Foundry for the box repository, file each work
// request as a Forgejo issue and start Foundry on it, write each run-result
// when its run ends, and release the landed requests that asked for one.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { readRequests, submitRequest } from "./intake.mjs";
import { releaseRequests } from "./release.mjs";
import { nodeResults, runResult } from "./results.mjs";

export const app = "software-foundry";
export const title = "Foundry box";

/** The checks Software Foundry approves for a repository other than the webapp (its foundryChecks). */
const BOX_CHECKS = [{ name: "test", commands: [["npm", "ci"], ["npm", "test"]] }];

/** @param {any} box the supervisor's driver context */
export async function run(box) {
  // The box has no GitHub Actions: checks run their approved commands in a workspace.
  const configured = await box.operator({ operation: "configure", repository: box.repository, reviewer: "reviewer", ci: "workspace",
    ...(box.env.BOX_MODEL || box.env.AI_MODEL ? { model: box.env.BOX_MODEL || box.env.AI_MODEL } : {}) });
  box.log(`Foundry configured for ${configured.repository} (subscription ${configured.subscriptionId})`);
  const pending = [];
  for (const { name, request } of readRequests(box.requests)) {
    const submitted = await submitRequest(request, { forgejo: box.forgejo, operator: box.operator, repository: box.repository });
    pending.push({ name, request, ...submitted, startedAt: new Date().toISOString() });
    box.log(`${name}: issue #${submitted.issue.number}, run ${submitted.run.id ?? "?"}`);
  }
  watchResults(box, pending);
}

/** Writes each request's run-result to /out/results once its run ends. */
function watchResults(box, pending) {
  const finished = [];
  const platform = createClient({ url: `file:${box.databases.platform}` });
  const gateway = createClient({ url: `file:${box.databases.gateway}` });
  /** A request's run-result once its run has ended, else undefined. */
  const resultOf = async (item) => {
    const [run] = (await platform.execute({ sql: "SELECT status, updatedAt FROM workflow_runs WHERE id=?", args: [item.run.id] })).rows;
    if (!run) return undefined;
    const snapshots = (await gateway.execute("SELECT snapshot FROM runs")).rows.map((row) => JSON.parse(String(row.snapshot)));
    return runResult({ forgejo: box.forgejo, repository: box.repository, request: item.request, issue: item.issue, run,
      nodes: nodeResults(snapshots, item.run.id), checks: BOX_CHECKS, model: box.model, startedAt: item.startedAt,
      finishedAt: new Date(Number(run.updatedAt)).toISOString() });
  };
  const poll = async () => {
    for (const item of [...pending]) {
      const result = await resultOf(item).catch((error) => box.log(`${item.name}: result not ready (${error.message})`));
      if (!result) continue;
      writeFileSync(join(box.out, "results", `${item.request.requestId}.json`), `${JSON.stringify(result, null, 2)}\n`);
      pending.splice(pending.indexOf(item), 1);
      finished.push({ ...item, result });
      box.log(`${item.name}: ${result.status}${result.change?.mergeSha ? ` at ${result.change.mergeSha.slice(0, 8)}` : ""}`);
    }
    if (pending.length) setTimeout(poll, 10_000).unref?.();
    else release(box, finished).then(() => box.finish(), (error) => box.finish(error));
  };
  void poll();
}

/** Releases the landed requests that asked for one. */
async function release(box, finished) {
  const released = finished.filter(({ request, result }) => request.release?.trigger && result.status === "landed");
  if (!released.length) return;
  const release = await releaseRequests({ released, forgejo: box.forgejo, store: box.store, repository: box.repository,
    remote: box.remote, branch: box.defaultBranch, model: released[0].result.model, out: box.out, image: box.image });
  for (const { request, result } of released)
    writeFileSync(join(box.out, "results", `${request.requestId}.json`), `${JSON.stringify({ ...result, release }, null, 2)}\n`);
  box.log(`released ${release.tag}: ${release.url}`);
}
