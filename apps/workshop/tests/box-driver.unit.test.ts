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

/** The platform's sign-in and Workshop's design agent, answering as the real routes do. */
function fakePlatform() {
  const calls: { host?: string; path?: string; body: any; cookie?: string }[] = [];
  let project: any;
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
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ project, rationale: "ok" }));
    });
  });
  return { server, calls };
}

test("the driver designs each request, commits it, and releases it with evidence", { timeout: 120_000 }, async () => {
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
      env: {}, log: () => {}, out: join(work, "out"), port: (server.address() as AddressInfo).port, image: "outfitter/workshop-box:dev",
      requests: join(work, "requests"), repository: "box/repo", defaultBranch: "main", remote: join(work, "remote.git"),
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
