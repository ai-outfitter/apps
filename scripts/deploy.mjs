import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkApp } from "./apps.mjs";

export async function requestDeployment(app, { env = process.env, fetcher = fetch } = {}) {
  assert.match(app, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(env.GITHUB_REF, `refs/heads/${env.DEPLOY_BRANCH || "main"}`, "Deploy only from the configured branch");
  assert.equal(env.GITHUB_EVENT_NAME, "push", "Deploy only after a push");
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && env.ACTIONS_ID_TOKEN_REQUEST_URL, "GitHub OIDC permission is required");
  const destination = new URL(env.OUTFITTER_URL || "https://ai-outfitter.com");
  assert.ok(destination.protocol === "https:" && !destination.username && !destination.password && destination.pathname === "/" && !destination.search && !destination.hash, "Destination must be an HTTPS origin");
  const tokenUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  tokenUrl.searchParams.set("audience", destination.origin);
  const tokenResponse = await fetcher(tokenUrl, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(tokenResponse.ok, `OIDC request failed (${tokenResponse.status})`);
  const { value: token } = await tokenResponse.json();
  assert.ok(typeof token === "string" && token.length > 0, "OIDC token is absent");
  // Do not retry: the platform owns deduplication and checks this token's SHA.
  const response = await fetcher(new URL("/api/app-repositories/deploy", destination).href, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ apps: [app] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 404)
    return { started: 0, unchanged: 0, failed: 0, notInstalled: true };
  assert.ok(response.ok, `Deployment request failed (${response.status})`);
  const result = await response.json();
  for (const key of ["started", "unchanged", "failed"])
    assert.ok(Number.isInteger(result[key]) && result[key] >= 0, `Invalid ${key} count`);
  assert.equal(result.failed, 0, `${app}: ${result.failed} deployment requests failed`);
  assert.ok(result.started + result.unchanged > 0, `${app}: no installations matched`);
  return { started: result.started, unchanged: result.unchanged, failed: result.failed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = process.argv[2];
  const selected = checkApp(app);
  const deploySlug = selected.manifest?.slug || selected.manifest?.catalog?.operational?.slug || app.split('/').at(-1);
  const result = await requestDeployment(deploySlug);
  const summary = result.notInstalled
    ? `${app}: no subscribed installations at ${process.env.OUTFITTER_URL || "https://ai-outfitter.com"}; nothing to update. Install this app once from Apps to receive automatic updates.\n`
    : `${app}: ${result.started} build/install requests queued; ${result.unchanged} unchanged. Queue acceptance is not completed deployment; inspect the app's installation history for build and activation results.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
