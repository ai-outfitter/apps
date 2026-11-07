// The Foundry box's release step. When the requests that asked for a release
// have landed, it tags the default branch with the next version, builds the
// release artifacts (a source archive and the full git history), stores them
// and an evidence bundle (ai-outfitter/apps:
// apps/software-foundry/box/schemas/evidence-bundle.schema.json) in RustFS,
// publishes a Forgejo release that links the bundle, and copies everything to
// /out/release/<tag>.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bumps = ["major", "minor", "patch"];
const semver = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** The next version after the highest semver tag, by the largest bump asked for. */
export function nextVersion(tags, requested) {
  const versions = tags.map((tag) => semver.exec(tag)).filter(Boolean).map((match) => match.slice(1, 4).map(Number));
  const [major, minor, patch] = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0] ?? [0, 0, 0];
  const bump = bumps.find((kind) => requested.includes(kind)) ?? "patch";
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The evidence bundle: what was built from which commit, and what backs each criterion. */
export function evidenceBundle({ tag, version, commitSha, build, model, released, artifacts }) {
  return {
    schemaVersion: 1,
    tag,
    version,
    commitSha,
    build,
    model,
    requests: released.map(({ request, result }) => ({
      requestId: request.requestId,
      ...(result.change?.pullRequest ? { pullRequest: result.change.pullRequest.number } : {}),
      commits: [result.change?.mergeSha ?? commitSha],
    })),
    checks: released.flatMap(({ result }) => result.checks),
    criteria: released.flatMap(({ request, result }) =>
      (result.change?.pullRequest?.acceptanceCriteria ?? request.acceptanceCriteria.map((criterion) => ({ id: criterion.id, status: "unverified", evidence: [] })))
        .map((criterion) => ({ requestId: request.requestId, id: criterion.id, status: criterion.status, evidence: criterion.evidence }))),
    artifacts,
  };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(directory, args) {
  const result = spawnSync("git", ["-c", "safe.directory=*", "-C", directory, ...args], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().slice(0, 500)}`);
  return result.stdout;
}

/**
 * Releases the landed requests. `forgejo(method, path, body)` calls Forgejo as
 * the bot; `store(key, bytes, type)` writes to the box bucket and returns its
 * s3:// URI; `remote` is an authenticated clone URL.
 */
export async function releaseRequests({ released, forgejo, store, repository, remote, branch, model, out, image }) {
  const startedAt = new Date().toISOString();
  const work = mkdtempSync(join(tmpdir(), "box-release-"));
  git(work, ["clone", "--quiet", "--branch", branch, remote, "repo"]);
  const repo = join(work, "repo");
  const commitSha = git(repo, ["rev-parse", "HEAD"]).toString().trim();
  const tags = git(repo, ["tag", "--list"]).toString().split("\n").filter(Boolean);
  const version = nextVersion(tags, released.map(({ request }) => request.release?.bump ?? "patch"));
  const tag = `v${version}`;
  const name = repository.split("/")[1];
  // The artifacts: the tagged source and the full history, byte for byte.
  const files = [
    { name: `${name}-${version}.tar.gz`, type: "application/gzip", bytes: git(repo, ["archive", "--format=tar.gz", `--prefix=${name}-${version}/`, commitSha]) },
  ];
  git(repo, ["bundle", "create", join(work, "history.bundle"), "--all"]);
  files.push({ name: `${name}-${version}.bundle`, type: "application/octet-stream", bytes: readFileSync(join(work, "history.bundle")) });
  const directory = join(out, "release", tag);
  mkdirSync(directory, { recursive: true });
  const artifacts = [];
  for (const file of files) {
    writeFileSync(join(directory, file.name), file.bytes);
    artifacts.push({ name: file.name, uri: await store(`releases/${tag}/${file.name}`, file.bytes, file.type), sha256: sha256(file.bytes), bytes: file.bytes.length });
  }
  const bundle = evidenceBundle({
    tag, version, commitSha, model, released, artifacts,
    build: { command: `git archive ${commitSha}; git bundle create --all`, image, startedAt, finishedAt: new Date().toISOString() },
  });
  const bundleBytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  writeFileSync(join(directory, "evidence-bundle.json"), bundleBytes);
  const evidence = { uri: await store(`releases/${tag}/evidence-bundle.json`, bundleBytes, "application/json"), sha256: sha256(bundleBytes) };
  // The tag and release on Forgejo; the release notes link the evidence bundle.
  const notes = [
    `Release ${tag} of ${repository} at ${commitSha}.`, "",
    ...released.map(({ request, result }) => `- ${request.title}${result.change?.pullRequest ? ` (#${result.change.pullRequest.number})` : ""}`), "",
    `Evidence bundle: ${evidence.uri} (sha256 ${evidence.sha256})`,
    ...artifacts.map((artifact) => `Artifact: ${artifact.name}, ${artifact.uri} (sha256 ${artifact.sha256})`),
  ].join("\n");
  const release = await forgejo("POST", `/repos/${repository}/releases`, { tag_name: tag, target_commitish: commitSha, name: tag, body: notes });
  return { tag, url: release.html_url, artifacts, evidenceBundle: evidence };
}
