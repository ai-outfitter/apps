import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const jsonHeaders = { "content-type": "application/json" };
const redirect = "http://localhost:33418/callback";

export async function signIn(root) {
  const response = await fetch(`${root}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { ...jsonHeaders, origin: root },
    body: JSON.stringify({ email: "local@example.test", password: "local-orgs-only" }),
  });
  assert.equal(response.status, 200, await response.text());
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  assert.ok(cookie, "sign-in returns the local fixture session");
  return cookie;
}

export async function oauthToken(root, cookie, scope) {
  const challenge = await fetch(`${root}/mcp`, { headers: { accept: "application/json" } });
  assert.equal(challenge.status, 401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate"))?.[1];
  assert.ok(metadataUrl, "MCP advertises its protected-resource metadata");
  const metadata = await fetch(metadataUrl);
  assert.equal(metadata.status, 200);
  const { resource, authorization_servers: [issuer] } = await metadata.json();
  const endpoint = `${issuer}/oauth2`;
  const response = await fetch(`${endpoint}/register`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      client_name: "Synthetic Foundry planning eval",
      redirect_uris: [redirect],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const registration = await response.json();
  assert.ok(registration.client_id, JSON.stringify(registration));
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(12).toString("hex");
  const authorize = new URL(`${endpoint}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code", client_id: registration.client_id, redirect_uri: redirect,
    scope, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", state, resource,
  });
  const pending = await fetch(authorize, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
  const consent = new URL(pending.headers.get("location") ?? (await pending.clone().json()).url, root);
  assert.equal(consent.pathname, "/oauth/consent", await pending.text());
  const approved = await fetch(consent, {
    method: "POST", redirect: "manual", headers: { cookie, origin: root },
    body: new URLSearchParams({ action: "approve" }),
  });
  const callback = new URL(approved.headers.get("location"), root);
  assert.equal(`${callback.origin}${callback.pathname}`, redirect, await approved.text());
  assert.equal(callback.searchParams.get("state"), state);
  const code = callback.searchParams.get("code");
  assert.ok(code, callback.searchParams.get("error_description"));
  const exchanged = await fetch(`${endpoint}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: redirect,
      client_id: registration.client_id, code_verifier: verifier, resource,
    }),
  });
  const grant = await exchanged.json();
  assert.equal(exchanged.status, 200, grant.error_description);
  assert.ok(grant.access_token);
  return { token: grant.access_token, resource };
}

export function mcpClient({ resource, token }) {
  let id = 0;
  return async (method, params) => {
    const response = await fetch(resource, {
      method: "POST",
      headers: {
        ...jsonHeaders, accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const encoded = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      : text;
    assert.ok(encoded, "MCP returned a JSON-RPC frame");
    const reply = JSON.parse(encoded);
    assert.equal(reply.id, id);
    assert.ok(reply.result || reply.error, text);
    return reply;
  };
}

export async function callTool(mcp, name, args) {
  const reply = await mcp("tools/call", { name, arguments: args });
  const text = reply.result?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  let value = reply.result?.structuredContent;
  if (!value && text && !reply.result.isError) {
    try { value = JSON.parse(text); } catch {}
  }
  return { value, text: text ?? reply.error?.message ?? "", refused: !!(reply.error || reply.result?.isError || value?.errors?.length) };
}
