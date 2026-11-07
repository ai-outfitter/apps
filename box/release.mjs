// The release step both drivers share. It tags the default branch with the
// next version, stores the release artifacts (the tagged source and the full
// git history) and the app's evidence bundle in RustFS, copies them to
// /out/release/<tag>, and publishes a Forgejo release that links them.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, nextVersion, sha256 } from "./lib.mjs";

/**
 * @param {any} box the supervisor's driver context
 * @param {{ bumps: string[], lines: string[], evidence: (release: { tag: string, version: string, commitSha: string,
 *   artifacts: any[], build: any }) => any }} input the bumps asked for, a release-notes line per item, and the app's evidence bundle
 * @returns {Promise<{ tag: string, url: string, artifacts: any[], evidenceBundle: { uri: string, sha256: string } }>}
 */
export async function publishRelease(box, { bumps, lines, evidence }) {
  const startedAt = new Date().toISOString();
  const work = mkdtempSync(join(tmpdir(), "box-release-"));
  try {
    git(work, ["clone", "--quiet", "--branch", box.defaultBranch, box.remote, "repo"]);
    const repo = join(work, "repo");
    const commitSha = git(repo, ["rev-parse", "HEAD"]).toString().trim();
    const version = nextVersion(git(repo, ["tag", "--list"]).toString().split("\n").filter(Boolean), bumps);
    const tag = `v${version}`;
    const name = box.repository.split("/")[1];
    git(repo, ["bundle", "create", join(work, "history.bundle"), "--all"]);
    const files = [
      { name: `${name}-${version}.tar.gz`, type: "application/gzip", bytes: git(repo, ["archive", "--format=tar.gz", `--prefix=${name}-${version}/`, commitSha]) },
      { name: `${name}-${version}.bundle`, type: "application/octet-stream", bytes: readFileSync(join(work, "history.bundle")) },
    ];
    const directory = join(box.out, "release", tag);
    mkdirSync(directory, { recursive: true });
    const artifacts = [];
    for (const file of files) {
      writeFileSync(join(directory, file.name), file.bytes);
      artifacts.push({ name: file.name, uri: await box.store(`releases/${tag}/${file.name}`, file.bytes, file.type), sha256: sha256(file.bytes), bytes: file.bytes.length });
    }
    const build = { command: `git archive ${commitSha}; git bundle create --all`, image: box.image, startedAt, finishedAt: new Date().toISOString() };
    const bundleBytes = Buffer.from(`${JSON.stringify(evidence({ tag, version, commitSha, artifacts, build }), null, 2)}\n`);
    writeFileSync(join(directory, "evidence-bundle.json"), bundleBytes);
    const evidenceBundle = { uri: await box.store(`releases/${tag}/evidence-bundle.json`, bundleBytes, "application/json"), sha256: sha256(bundleBytes) };
    const notes = [
      `Release ${tag} of ${box.repository} at ${commitSha}.`, "", ...lines, "",
      `Evidence bundle: ${evidenceBundle.uri} (sha256 ${evidenceBundle.sha256})`,
      ...artifacts.map((artifact) => `Artifact: ${artifact.name}, ${artifact.uri} (sha256 ${artifact.sha256})`),
    ].join("\n");
    const release = await box.forgejo("POST", `/repos/${box.repository}/releases`, { tag_name: tag, target_commitish: commitSha, name: tag, body: notes });
    box.log(`released ${tag}: ${release.html_url}`);
    return { tag, url: release.html_url, artifacts, evidenceBundle };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
