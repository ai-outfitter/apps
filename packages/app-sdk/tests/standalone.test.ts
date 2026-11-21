import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createClient, type InValue } from "@libsql/client";
import { outfitterApp, standaloneMigrations, standaloneWorkflows } from "../src/astro";
import { requestIdentity } from "../src/server";
import {
  forwardedRequest,
  googleFinish,
  oauthCookie,
  returnPath,
  sign,
  standaloneAuthConfig,
  standaloneIdentity,
  verify,
  type StandaloneAuthConfig,
} from "../src/standalone-auth";
import { type StandaloneDatabase, standaloneHost } from "../src/standalone-host";
import { standaloneHostKey, workflowHost } from "../src/workflow-host";

const config = (overrides: Partial<StandaloneAuthConfig> = {}): StandaloneAuthConfig => ({
  ...(standaloneAuthConfig({ SESSION_SECRET: "a-secret-of-enough-length" }, "workshop", false) as StandaloneAuthConfig),
  ...overrides,
});
const member = { id: "local:ada@example.com", name: "Ada", email: "ada@example.com" };

test("a deployed standalone app needs a session secret; astro dev has its own", () => {
  assert.match(String(standaloneAuthConfig({}, "workshop", false)), /SESSION_SECRET/);
  assert.equal(typeof standaloneAuthConfig({}, "workshop", true), "object");
});

test("signed sessions verify, and tampered or expired ones do not", async () => {
  const token = await sign("a-secret-of-enough-length", { ...member, exp: 2_000_000_000 });
  assert.deepEqual(await verify("a-secret-of-enough-length", token), { ...member, exp: 2_000_000_000 });
  assert.equal(await verify("another-secret-of-length", token), undefined);
  assert.equal(await verify("a-secret-of-enough-length", `${token.slice(0, -2)}xx`), undefined);
  const expired = await sign("a-secret-of-enough-length", { ...member, exp: 1 });
  assert.equal(await verify("a-secret-of-enough-length", expired), undefined);
});

test("sign-in returns only to same-origin paths", () => {
  assert.equal(returnPath("/projects/a?b=1"), "/projects/a?b=1");
  for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "/login", null]) assert.equal(returnPath(value), "/");
});

test("the forwarded request carries only the member's identity", () => {
  const spoofed = new Request("https://workshop.example/api/x", {
    headers: { "x-outfitter-user": "someone-else", "x-outfitter-role": "owner", "x-outfitter-entity-writer": "app", cookie: "a=b" },
  });
  const forwarded = forwardedRequest(spoofed, standaloneIdentity(config({ adminEmails: ["boss@example.com"] }), member));
  const identity = requestIdentity(forwarded);
  assert.equal(identity.userId, member.id);
  assert.equal(identity.role, "member");
  assert.equal(identity.access, "write");
  assert.equal(identity.organizationId, "workshop");
  assert.equal(identity.entityWriter, undefined);
  assert.equal(forwarded.headers.get("cookie"), "a=b");
  // With no admins named, everyone who may sign in owns the app.
  assert.equal(requestIdentity(forwardedRequest(spoofed, standaloneIdentity(config(), member))).access, "admin");
});

async function googleCallback(claims: Record<string, unknown>, auth = config({ allowedDomains: ["example.com"] })) {
  const google = { clientId: "client", clientSecret: "secret" };
  const pending = await sign(auth.secret, { state: "s1", verifier: "v", returnTo: "/projects", exp: 2_000_000_000 });
  const request = new Request("https://workshop.example/login/google/callback?state=s1&code=c1", { headers: { cookie: `${oauthCookie}=${pending}` } });
  const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: "client", exp: 2_000_000_000, sub: "42", email: "ada@example.com", email_verified: true, name: "Ada", ...claims })).toString("base64url");
  let sent: URLSearchParams | undefined;
  const result = await googleFinish(request, { ...auth, google }, (async (_url: string, init: RequestInit) => {
    sent = init.body as URLSearchParams;
    return Response.json({ id_token: `h.${payload}.s` });
  }) as typeof fetch);
  return { result, sent };
}

test("Google sign-in admits verified, allowed accounts and keeps PKCE", async () => {
  const { result, sent } = await googleCallback({});
  assert.deepEqual(result, { member: { id: "google:42", email: "ada@example.com", name: "Ada" }, returnTo: "/projects" });
  assert.equal(sent?.get("code_verifier"), "v");
  assert.equal(sent?.get("redirect_uri"), "https://workshop.example/login/google/callback");
  assert.ok("refused" in (await googleCallback({ email_verified: false })).result);
  assert.ok("refused" in (await googleCallback({ aud: "other" })).result);
  assert.ok("refused" in (await googleCallback({ email: "eve@elsewhere.example" })).result);
  assert.match(JSON.stringify((await googleCallback({}, config())).result), /No one may sign in yet/);
});

function libsql(): StandaloneDatabase {
  const client = createClient({ url: ":memory:" });
  return {
    all: async (sql, params = []) => (await client.execute({ sql, args: params as InValue[] })).rows as unknown as Record<string, unknown>[],
    run: async (sql, params = []) => void (await client.execute({ sql, args: params as InValue[] })),
  };
}

const workflows = { "workshop-design": { design: { inference: { maxOutputTokens: 16000, timeoutMs: 840000 }, outputs: ["design"] } } };

test("the standalone host runs an app workflow: start, structured inference, collect", async () => {
  const requests: Record<string, unknown>[] = [];
  const stub = standaloneHost({
    db: libsql(),
    member,
    workflows,
    inference: {
      baseUrl: "https://models.example/v1/",
      apiKey: "key",
      model: "a-model",
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, ...JSON.parse(String(init.body)) });
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ name: "Box" }) } }] });
      }) as typeof fetch,
    },
  });
  const host = workflowHost<"interactive">({ [standaloneHostKey]: stub } as never);
  const id = crypto.randomUUID();
  const inputs = { "design.inputs.message": "a box" };
  assert.deepEqual(await host.call("workflow.start", { workflow: "workshop-design", id, inputs }), { id, workflow: "workshop-design", created: true });
  assert.equal((await host.call("workflow.start", { workflow: "workshop-design", id, inputs })).created, false);
  await assert.rejects(host.call("workflow.start", { workflow: "workshop-design", id, inputs: {} }), (error: Response) => error.status === 409);
  const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
  assert.deepEqual(await host.call("inference.generate", { runId: id, step: "design", instructions: "Design it.", data: { message: "a box" }, schema }), { output: { name: "Box" } });
  assert.equal(requests[0].url, "https://models.example/v1/chat/completions");
  assert.equal(requests[0].max_completion_tokens, 16000);
  assert.equal(requests[0].model, "a-model");
  assert.deepEqual((requests[0].response_format as { json_schema: { strict: boolean } }).json_schema.strict, true);
  assert.deepEqual(await host.call("workflow.collect", { runId: id, slot: "design.outputs.design", value: { ok: true } }), { run: "complete", steps: { design: "complete" } });
  await assert.rejects(host.call("inference.generate", { runId: id, instructions: "x", data: {}, schema }), (error: Response) => error.status === 409);
  const activity = await host.call("workflow.activity", { slots: ["design.inputs.message"], steps: true });
  assert.equal(activity.total, 1);
  assert.deepEqual(activity.items[0].inputs, inputs);
  assert.deepEqual(activity.items[0].completedSteps, ["design"]);
  assert.equal((await host.call("identity.current", {})).email, member.email);
  // What reaches other apps or the platform is not served standalone.
  await assert.rejects(host.call("entities.list", { installationId: "wiki" } as never), (error: Response) => error.status === 501);
});

test("a model answer outside the schema, or no model configured, is refused", async () => {
  const run = async (inference: Parameters<typeof standaloneHost>[0]["inference"]) => {
    const host = workflowHost<"interactive">({ [standaloneHostKey]: standaloneHost({ db: libsql(), member, workflows, inference }) } as never);
    const id = crypto.randomUUID();
    await host.call("workflow.start", { workflow: "workshop-design", id, inputs: {} });
    return host.call("inference.generate", { runId: id, instructions: "x", data: {}, schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } });
  };
  await assert.rejects(run({ baseUrl: "https://models.example/v1" }), (error: Response) => error.status === 503);
  const wrong = (async () => Response.json({ choices: [{ message: { content: '{"n":"one"}' } }] })) as unknown as typeof fetch;
  await assert.rejects(run({ baseUrl: "https://m.example", apiKey: "k", model: "m", fetch: wrong }), (error: Response) => error.status === 502);
});

test("standalone mode registers sign-in ahead of the app middleware with the app's migrations and workflows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outfitter-standalone-"));
  try {
    await mkdir(join(directory, "migrations"));
    await writeFile(join(directory, "migrations", "0000_things.sql"), "CREATE TABLE things (id TEXT PRIMARY KEY)");
    await mkdir(join(directory, "workflows", "make"), { recursive: true });
    await writeFile(join(directory, "workflows", "make", "workflow.yaml"), "id: make\nsteps:\n  - id: draft\n    inference: {maxOutputTokens: 900}\n    outputs:\n      result: {schema: {type: object}}\n");
    assert.deepEqual(standaloneMigrations(directory, true).map((migration) => migration.name), ["0000_outfitter_app_storage", "0000_things"]);
    assert.deepEqual(standaloneWorkflows(directory), { make: { draft: { inference: { maxOutputTokens: 900 }, outputs: ["result"] } } });
    const added: { entrypoint: string | URL; order: string }[] = [];
    const setup = outfitterApp({ app: "example", contentSecurityPolicy: "default-src 'none'", standalone: true, name: "Example" }).hooks["astro:config:setup"] as (hooks: unknown) => void;
    setup({ addMiddleware: (middleware: (typeof added)[number]) => added.push(middleware), command: "dev", createCodegenDir: () => pathToFileURL(`${directory}/`), config: { root: pathToFileURL(`${directory}/`) } });
    assert.equal(added.length, 2);
    const standalone = await readFile(added[0].entrypoint, "utf8");
    assert.match(standalone, /standaloneMiddleware\(\{"app":"example","name":"Example","dev":true,"migrations":\[\{"name":"0000_things"/);
    assert.match(await readFile(added[1].entrypoint, "utf8"), /appMiddleware/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
