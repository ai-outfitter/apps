import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { api, issue, mintWorkerRotation } from "./fixture.mjs";

export async function grantRepositories(auth) {
  const repositories = {};
  for (const name of ["grant-a", "grant-b", "grant-c", "grant-d"]) {
    const repo = await api(auth.admin, "/orgs/box/repos", "POST", { name, private: true, auto_init: true });
    if (name !== "grant-d") {
      await api(auth.admin, `/repos/${repo.full_name}/collaborators/outfitter`, "PUT",
        { permission: name === "grant-c" ? "read" : "write" });
    }
    repositories[name] = repo.id;
  }
  return repositories;
}

export async function sessionRequest(root, cookie, path, method, body) {
  const response = await fetch(new URL(path, root), {
    method, redirect: "manual", signal: AbortSignal.timeout(48_000),
    headers: { cookie, origin: root, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch {}
  return { status: response.status, data, ...(response.ok ? {} : { error: text.slice(0, 300) }) };
}

export async function waitFor(read, description, maxMs = 40_000) {
  const deadline = Date.now() + maxMs;
  do {
    const value = await read();
    if (value) return value;
    await sleep(80);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

export async function exerciseGrants({ box, db, root, cookie, report, repositories, auth }) {
  const { organizationId, id: installationId } = report.installation;
  const connection = `/api/organizations/${organizationId}/forgejo`;
  const grant = (name, overrides = {}) => ({
    installationId, connectionId: "box-forgejo", repository: `box/${name}`,
    repositoryId: repositories[name], permission: "write", ...overrides,
  });
  const send = (input, session = cookie, path = connection) =>
    sessionRequest(root, session, `${path}/repositories`, "POST", input);
  const read = () => db.prepare("SELECT config, revision, externalId FROM connections WHERE id = 'box-forgejo'").get();
  const secret = () => db.prepare("SELECT encryptedSecret FROM connections WHERE id = 'box-forgejo'").get().encryptedSecret;
  const originalSecret = secret();
  const initial = read();
  const negatives = {
    unauthenticated: await send(grant("grant-a"), ""),
    wrongTenant: await send(grant("grant-a"), cookie, "/api/organizations/not-this-tenant/forgejo"),
    wrongInstallation: await send(grant("grant-a", { installationId: "not-this-installation" })),
    wrongForgejoId: await send(grant("grant-a", { repositoryId: repositories["grant-b"] })),
    unrelatedCredential: await send(grant("grant-a", { token: "not-a-credential" })),
    writeOnReadOnly: await send(grant("grant-c")),
    privateWithoutAccess: await send(grant("grant-d")),
  };
  report.grants = { negatives };
  for (const [name, result] of Object.entries(negatives)) {
    assert.ok([400, 401, 403, 404, 409, 422].includes(result.status), `Expected ${name} refusal, got ${result.status}`);
  }
  assert.deepEqual(read(), initial, "Rejected grants preserve configuration and revision");

  const out = name => join(box.out, name);
  writeFileSync(out("provider-hold.json"), JSON.stringify({ path: "/api/v1/repos/box/grant-a" }));
  const first = send(grant("grant-a"));
  let rotatedSecret;
  try {
    await waitFor(() => existsSync(out("provider-held.json")), "first grant's native repository read");
    assert.deepEqual(read(), initial, "First request is in flight before storing its grant");
    const second = await send(grant("grant-b"));
    const afterSecond = read();
    assert.equal(second.status, 200, JSON.stringify(second));
    assert.notEqual(afterSecond.revision, initial.revision);
    const token = mintWorkerRotation(box);
    assert.ok(`token ${token}` !== auth.worker, "Native rotation returned a distinct credential");
    assert.equal((await api(`token ${token}`, "/user")).id, Number(initial.externalId));
    const edited = await sessionRequest(root, cookie, connection, "PUT", {
      revision: afterSecond.revision, origin: JSON.parse(initial.config).origin, token,
      repositories: [...JSON.parse(afterSecond.config).repositories, "box/grant-c"],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited));
    const afterEdit = read();
    assert.notEqual(afterEdit.revision, afterSecond.revision);
    assert.deepEqual(JSON.parse(afterEdit.config).repositoryGrants, JSON.parse(afterSecond.config).repositoryGrants);
    rotatedSecret = secret();
    assert.ok(rotatedSecret !== originalSecret, "Settings installed the replacement credential");
    report.grants.overlap = { second: second.data, editRevision: afterEdit.revision, credentialRotated: true };
    report.grants.editConfig = JSON.parse(afterEdit.config);
  } finally {
    writeFileSync(out("provider-release"), "");
    await first;
  }

  const result = await first;
  assert.equal(result.status, 200, JSON.stringify(result));
  for (const [name, response] of [["grant-a", result.data], ["grant-b", report.grants.overlap.second]]) {
    assert.deepEqual(response, { connectionId: "box-forgejo", repository: `box/${name}`,
      repositoryId: repositories[name], permission: "write" });
  }
  const beforeRepeat = read();
  assert.ok(secret() === rotatedSecret, "Racing grant preserves the exact stored replacement credential");
  const config = JSON.parse(beforeRepeat.config);
  assert.equal(beforeRepeat.externalId, initial.externalId);
  assert.deepEqual(new Set(config.repositories), new Set([issue.repository, "box/grant-a", "box/grant-b", "box/grant-c"]));
  assert.deepEqual(config.repositoryGrants, {
    "box/grant-a": { repositoryId: repositories["grant-a"], permission: "write", explicitOnly: true },
    "box/grant-b": { repositoryId: repositories["grant-b"], permission: "write", explicitOnly: true },
  });
  assert.deepEqual(await send(grant("grant-a")), result, "Repetition returns the original grant shape");
  assert.deepEqual(read(), beforeRepeat, "Repeat leaves the revision and other grants intact");
  const grantedRead = await send(grant("grant-c", { permission: "read" }));
  assert.equal(grantedRead.status, 200, JSON.stringify(grantedRead));
  const afterRead = read();
  assert.notEqual(afterRead.revision, beforeRepeat.revision);
  const final = JSON.parse(afterRead.config);
  assert.deepEqual(final.repositoryGrants, { ...config.repositoryGrants,
    "box/grant-c": { repositoryId: repositories["grant-c"], permission: "read" } });
  assert.equal((await send(grant("grant-c"))).status, 409, "A read grant may not be converted into write");
  assert.deepEqual(read(), afterRead);
  report.grants.final = final;
}


export async function exerciseRevokedGrant({ box, db, root, cookie, report, repositories }) {
  const { organizationId, id: installationId } = report.installation;
  const out = name => join(box.out, name);
  const read = () => db.prepare("SELECT config, revision FROM connections WHERE id = 'box-forgejo'").get();
  const initial = read();
  writeFileSync(out("provider-hold.json"), JSON.stringify({ path: "/api/v1/repos/box/grant-a" }));
  const first = sessionRequest(root, cookie, `/api/organizations/${organizationId}/forgejo/repositories`, "POST", {
    installationId, connectionId: "box-forgejo", repository: "box/grant-a",
    repositoryId: repositories["grant-a"], permission: "write",
  });
  const state = new DatabaseSync(box.databases.platform);
  state.exec("PRAGMA busy_timeout=5000");
  const member = state.prepare("SELECT id, role FROM member WHERE organizationId = ? AND userId = 'local-viewer'").get(organizationId);
  assert.ok(member?.role.includes("owner") || member?.role.includes("admin"));
  try {
    await waitFor(() => existsSync(out("provider-held.json")), "grant preflight finished at the native provider");
    assert.deepEqual(read(), initial);
    assert.equal(state.prepare("UPDATE member SET role = 'member' WHERE id = ?").run(member.id).changes, 1);
    writeFileSync(out("provider-release"), "");
    const refused = await first;
    assert.equal(refused.status, 403, JSON.stringify(refused));
    assert.deepEqual(read(), initial, "The in-flight grant did not survive demotion");
    report.revokedGrant = { result: refused.status, beforeRole: member.role, changedRole: "member" };
  } finally {
    writeFileSync(out("provider-release"), "");
    try { await first; } finally {
      state.prepare("UPDATE member SET role = ? WHERE id = ?").run(member.role, member.id);
      state.close();
    }
  }
}
