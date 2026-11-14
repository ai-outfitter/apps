import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../box/driver.mjs";
import { makeProject } from "../src/lib/project";
import { DesignResult, EvidenceBundle } from "../src/box/contract";

const request = JSON.parse(readFileSync(new URL("../box/fixtures/design-request.json", import.meta.url), "utf8"));

/** The platform's sign-in, Workshop's design agent and the platform's MCP dispatch, answering as the real routes do. */
function fakePlatform() {
  const calls: { host?: string; path?: string; body: any; cookie?: string }[] = [];
  let project: any;
  /** Design runs started through the graph API, by id, with how many times each was read. */
  const runs = new Map<string, { reads: number; design: { projectId: string; revision: number } }>();
  const design = (body: { message: string; projectId?: string }) => {
    // First turn: a 10 mm hole; the follow-up widens it to 12 mm.
    const radius = body.projectId ? 6 : 5;
    const base = project ?? { ...makeProject("cube"), id: crypto.randomUUID(), name: "Cable clip", revision: 0, iterations: [] };
    const revision = base.revision + 1;
    project = { ...base, revision,
      params: { ...base.params, design: "custom", width: 60, depth: 40, height: 20 },
      cadPlan: { version: 1, units: "mm", features: [
        { kind: "box", mode: "add", origin: [-30, -20, 0], size: [60, 40, 20] },
        { kind: "cylinder", mode: "cut", base: [0, 0, 0], radius, height: 20, axis: "z" }] },
      iterations: [...base.iterations, { id: crypto.randomUUID(), prompt: body.message, rationale: "Block with a hole.",
        dimensions: { width: 60, depth: 40, height: 20 }, at: new Date().toISOString(), revision }] };
    return project;
  };
  /** graph_mutate and graph_query as the platform's MCP dispatch answers them: a tool result whose text is the JSON answer. */
  const tool = ({ name, arguments: args }: { name: string; arguments: any }) => {
    const input = args.variables.input;
    if (name === "graph_mutate" && args.document === "StartWorkshopDesign") {
      if (input.projectId && input.revision !== project?.revision) return { content: [{ type: "text", text: "Project changed in another session. Reload and retry." }], isError: true };
      const { id, ...body } = input;
      const saved = design(body);
      runs.set(id, { reads: 0, design: { projectId: saved.id, revision: saved.revision } });
      return { content: [{ type: "text", text: JSON.stringify({ data: { startWorkshopDesign: { id, status: "running", design: null, created: true } } }) }] };
    }
    const run = runs.get(input.id);
    if (name !== "graph_query" || args.document !== "WorkshopDesignRun" || !run) return { content: [{ type: "text", text: "Not found" }], isError: true };
    // The first read finds the run still working; a query answers one entry per installation.
    const view = run.reads++ ? { id: input.id, status: "complete", design: run.design } : { id: input.id, status: "running", design: null };
    return { content: [{ type: "text", text: JSON.stringify({ data: { workshop: [{ installationId: "local-box-workshop", workshopDesignRun: view }] } }) }] };
  };
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      // No workbench page here, so the driver's screenshots fail fast and the design goes on.
      if (req.url?.startsWith("/projects/")) return res.writeHead(404).end();
      const body = JSON.parse(text || "{}");
      calls.push({ host: req.headers.host, path: req.url, body, cookie: req.headers.cookie });
      if (req.url === "/api/auth/sign-in/email") {
        res.writeHead(200, { "Set-Cookie": "session=abc; Path=/; HttpOnly", "Content-Type": "application/json" });
        return res.end("{}");
      }
      if (req.headers.cookie !== "session=abc") return res.writeHead(401).end();
      if (req.url === "/debug/mcp/rpc") {
        // The streamable HTTP reply: a JSON body for a write, one event of a stream for a read.
        const reply = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: tool(body.params) });
        return body.params.name === "graph_mutate"
          ? res.writeHead(200, { "Content-Type": "application/json" }).end(reply)
          : res.writeHead(200, { "Content-Type": "text/event-stream" }).end(`event: message\ndata: ${reply}\n\n`);
      }
      if (req.method === "GET" && req.url === `/api/apps/workshop/projects/${project?.id}`) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(project));
      design(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ project, rationale: "ok" }));
    });
  });
  return { server, calls };
}

/** Runs the driver on one request against the stand-in platform and a local git remote. */
async function drive(request: Record<string, unknown>) {
  const work = mkdtempSync(join(tmpdir(), "workshop-driver-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  // The box repository, as Forgejo would hold it.
  mkdirSync(join(work, "seed"));
  git(work, "init", "--quiet", "--bare", "--initial-branch=main", "remote.git");
  git(join(work, "seed"), "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(work, "seed", "README.md"), "# Desk parts\n");
  git(join(work, "seed"), "add", "-A");
  git(join(work, "seed"), "commit", "--quiet", "-m", "init");
  git(join(work, "seed"), "push", "--quiet", join(work, "remote.git"), "main");
  mkdirSync(join(work, "requests"));
  writeFileSync(join(work, "requests", "clip.json"), JSON.stringify(request));
  mkdirSync(join(work, "out", "results"), { recursive: true });

  const { server, calls } = fakePlatform();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stored: Record<string, number> = {};
  const releases: any[] = [];
  let finished!: (error?: unknown) => void;
  const done = new Promise<unknown>((resolve) => (finished = resolve));
  try {
    await run({
      env: { BOX_EXIT_WHEN_DONE: "1" }, log: () => {}, out: join(work, "out"), port: (server.address() as AddressInfo).port, image: "outfitter/workshop-box:dev",
      pollMs: 5, requests: join(work, "requests"), repository: "box/repo", defaultBranch: "main", remote: join(work, "remote.git"),
      model: { provider: "spark", id: "GLM-5.3-Flash-EXL3" },
      forgejo: async (method: string, path: string, body: any) => {
        releases.push({ method, path, body });
        return { html_url: "http://127.0.0.1:3300/box/repo/releases/tag/v0.1.0" };
      },
      store: async (key: string, bytes: Buffer) => {
        stored[key] = bytes.length;
        return `s3://workshop/${key}`;
      },
      finish: (error?: unknown) => finished(error),
    });
    assert.equal(await done, undefined);
  } finally {
    server.close();
  }
  return { work, git, calls, stored, releases };
}

test("the driver designs each request, commits it, and releases it with evidence", { timeout: 120_000 }, async () => {
  const { work, git, calls, stored, releases } = await drive(request);

  // Signed in on the platform host, then two agent turns on Workshop's host.
  assert.match(calls[0].host ?? "", /^outfitter\.localhost:/);
  assert.deepEqual(calls.slice(1).map((call) => [call.host?.split(":")[0], call.path, call.body.message]), [
    ["workshop.box.outfitter.localhost", "/api/apps/workshop/agent", request.message],
    ["workshop.box.outfitter.localhost", "/api/apps/workshop/agent", request.followUps[0]],
  ]);
  assert.equal(calls[2].body.revision, 1);

  const result = DesignResult.parse(JSON.parse(readFileSync(join(work, "out", "results", `${request.requestId}.json`), "utf8")));
  assert.equal(result.status, "designed");
  assert.equal(result.project?.revision, 2);
  // The design agent's turns are one pi-format session, on the sessions branch with Git LFS and in /out.
  assert.deepEqual(result.sessions?.files.map((file) => file.agent), ["design-agent"]);
  assert.equal(git(join(work, "remote.git"), "rev-parse", "outfitter/sessions").trim(), result.sessions?.commitSha);
  const session = readFileSync(join(work, "out", "sessions", request.requestId, "design-agent.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(session.filter((entry) => entry.type === "message").map((entry) => entry.message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(session[2].message.content[0].text, "ok");
  // Each turn and the export are timed; without the platform database the tokens are unknown.
  assert.deepEqual(result.metrics?.steps.map((step) => [step.name, step.status]), [["design", "succeeded"], ["follow-up 1", "succeeded"], ["export", "succeeded"]]);
  assert.ok(Math.abs((result.geometry?.volumeMm3 ?? 0) - (48000 - Math.PI * 36 * 20)) < 1);
  assert.equal(result.release?.tag, "v0.1.0");
  // The design revision is one commit on main with the model files.
  const files = git(join(work, "remote.git"), "ls-tree", "-r", "--name-only", "main").split("\n").filter(Boolean);
  assert.deepEqual(files.sort(), ["README.md", "designs/cable-clip/bom.json", "designs/cable-clip/model.step", "designs/cable-clip/model.stl", "designs/cable-clip/project.json"]);
  assert.equal(git(join(work, "remote.git"), "rev-parse", "main").trim(), result.commitSha);
  assert.ok(stored[`designs/${request.requestId}/model.step`] > 0);
  // The release links its evidence bundle, which pins the design's commit.
  assert.equal(releases[0].path, "/repos/box/repo/releases");
  assert.match(releases[0].body.body, /Evidence bundle: s3:\/\/workshop\/releases\/v0\.1\.0\/evidence-bundle\.json/);
  const bundle = EvidenceBundle.parse(JSON.parse(readFileSync(join(work, "out", "release", "v0.1.0", "evidence-bundle.json"), "utf8")));
  assert.equal(bundle.designs[0].commitSha, result.commitSha);
});

test("a request with via graphql starts each turn with StartWorkshopDesign and follows its run", { timeout: 120_000 }, async () => {
  const { work, git, calls } = await drive({ ...request, via: "graphql", release: undefined });
  // Every turn goes through the platform's MCP dispatch on the platform host, signed in as the member; none posts to the design route.
  const tools = calls.filter((call) => call.path === "/debug/mcp/rpc");
  assert.ok(tools.every((call) => call.host?.startsWith("outfitter.localhost:") && call.cookie === "session=abc" && call.body.method === "tools/call"));
  assert.equal(calls.some((call) => call.path === "/api/apps/workshop/agent"), false);
  const starts = tools.filter((call) => call.body.params.name === "graph_mutate").map((call) => call.body.params.arguments);
  assert.deepEqual(starts.map((args) => [args.scope, args.app, args.document, args.variables.input.message, args.variables.input.revision]), [
    ["box", "workshop", "StartWorkshopDesign", request.message, undefined],
    ["box", "workshop", "StartWorkshopDesign", request.followUps[0], 1],
  ]);
  // Each run is read until it is complete: once while running, once finished, by the id the start chose.
  const reads = tools.filter((call) => call.body.params.name === "graph_query").map((call) => call.body.params.arguments);
  assert.deepEqual(reads.map((args) => [args.document, args.variables.input.id, args.includeIdentifiers]),
    starts.flatMap((args) => [["WorkshopDesignRun", args.variables.input.id, true], ["WorkshopDesignRun", args.variables.input.id, true]]));

  // The result is graded like any other: the same files, with the path the turns took recorded.
  const result = DesignResult.parse(JSON.parse(readFileSync(join(work, "out", "results", `${request.requestId}.json`), "utf8")));
  assert.deepEqual([result.status, result.via, result.project?.revision], ["designed", "graphql", 2]);
  assert.deepEqual(result.metrics?.steps.map((step) => [step.name, step.status]), [["design", "succeeded"], ["follow-up 1", "succeeded"], ["export", "succeeded"]]);
  assert.ok(Math.abs((result.geometry?.volumeMm3 ?? 0) - (48000 - Math.PI * 36 * 20)) < 1);
  const files = git(join(work, "remote.git"), "ls-tree", "-r", "--name-only", "main").split("\n").filter(Boolean);
  assert.ok(files.includes("designs/cable-clip/model.stl"));
  // The session records the agent's rationale, read from the saved project.
  const session = readFileSync(join(work, "out", "sessions", request.requestId, "design-agent.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(session[2].message.content[0].text, "Block with a hole.");
});
