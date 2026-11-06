import assert from "node:assert/strict";
import test from "node:test";
import { requestDeployment } from "../deploy.mjs";

const env = {
  GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid/token?request=1",
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
test("deployment obtains an audience-bound token and requests exactly one app", async () => {
  const calls = [];
  const result = await requestDeployment("strength-five", { env, fetcher: async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? json({ value: "identity-token" }) : json({ started: 2, unchanged: 0, failed: 0 }, 202);
  } });
  assert.equal(new URL(calls[0].url).searchParams.get("audience"), "https://ai-outfitter.com");
  assert.equal(calls[1].init.headers.Authorization, "Bearer identity-token");
  assert.deepEqual(JSON.parse(calls[1].init.body), { apps: ["strength-five"] });
  assert.deepEqual(result, { started: 2, unchanged: 0, failed: 0 });
});
test("PRs, other branches and missing OIDC never send a request", async () => {
  for (const invalid of [{ GITHUB_REF: "refs/pull/1/merge" }, { GITHUB_EVENT_NAME: "pull_request" }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }])
    await assert.rejects(requestDeployment("yoga-practice", { env: { ...env, ...invalid }, fetcher: () => { throw Error("must not fetch"); } }));
});
test("HTTP errors, partial failures, malformed replies and unmatched apps fail", async () => {
  for (const response of [json({}, 403), json({ started: 1, unchanged: 0, failed: 1 }, 202), json({ started: 0, unchanged: 0, failed: 0 }, 202), json({})]) {
    let calls = 0;
    await assert.rejects(requestDeployment("yoga-practice", { env, fetcher: async () => ++calls === 1 ? json({ value: "token" }) : response }));
    assert.equal(calls, 2);
  }
});

test("self-hosted deployment binds audience and request to the chosen origin", async () => {
  const calls = [];
  await requestDeployment("custom-app", {env: {...env, OUTFITTER_URL:"https://outfitter.example.org"}, fetcher: async (url, init) => {
    calls.push(String(url)); return calls.length===1 ? json({value:"token"}) : json({started:1,unchanged:0,failed:0},202);
  }});
  assert.equal(new URL(calls[0]).searchParams.get("audience"),"https://outfitter.example.org");
  assert.equal(calls[1],"https://outfitter.example.org/api/app-repositories/deploy");
});
test("rejects malformed or insecure deployment origins before requesting credentials", async () => {
  for (const url of ["http://localhost", "https://user:pass@host", "https://host/subpath", "https://host?token=secret"]) {
    await assert.rejects(requestDeployment("app",{env:{...env,OUTFITTER_URL:url},fetcher:()=>{throw Error("must not fetch");}}));
  }
});

test("apps without subscribed installations do not fail a repository deployment", async () => {
  let calls=0;
  const result=await requestDeployment("strength-five",{env,fetcher:async()=>++calls===1 ? json({value:"token"}) : json({},404)});
  assert.deepEqual(result,{started:0,unchanged:0,failed:0,notInstalled:true});
  assert.equal(calls,2);
});
