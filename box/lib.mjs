// Helpers box drivers share: git in a clone, hashes and release versions.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Runs git in a directory and returns its stdout as a Buffer. */
export function git(directory, args, { author } = {}) {
  const identity = author ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`] : [];
  const result = spawnSync("git", ["-c", "safe.directory=*", ...identity, "-C", directory, ...args], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().slice(0, 500)}`);
  return result.stdout;
}

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

/** A lowercase slug of at most 64 characters, for folder names. */
export const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "") || "design";
