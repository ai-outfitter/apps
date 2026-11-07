// Every agent session a box request produced, kept three ways:
//  - /out/sessions/<requestId>/<agent>.jsonl, one pi session per agent, plus
//    transcript.jsonl, all of them merged in time order for Agent Eval;
//  - committed with Git LFS to the box repository's sessions branch, under
//    sessions/<requestId>/ (Forgejo keeps the LFS objects in RustFS).
// Sessions use pi's session format: one JSON entry per line, each message as
// { type: "message", timestamp, message: { role, content, timestamp, usage } }.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, sha256 } from "./lib.mjs";

export const SESSIONS_BRANCH = "outfitter/sessions";
const AUTHOR = { name: "Outfitter box", email: "box@box.local" };

/** A pi session file's entries (unreadable lines are left out). */
export function readSession(path) {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** The pi session files a workspace runtime wrote for one of its runs, anywhere under `root`. */
export function sessionFiles(root, runId) {
  if (!root || !existsSync(root)) return [];
  const name = new RegExp(`^workflow-${runId.replace(/[^a-z0-9-]/gi, "")}-[a-z0-9-]+\\.jsonl$`, "i");
  const found = [];
  const walk = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) walk(path, depth + 1);
      else if (entry.isFile() && name.test(entry.name)) found.push(path);
    }
  };
  walk(root, 0);
  return found.sort();
}

const time = (entry) => {
  const value = entry.message?.timestamp ?? entry.timestamp;
  return typeof value === "number" ? value : Date.parse(value ?? "") || 0;
};

/** All sessions' messages in time order, as the `message_end` events Agent
 * Eval's pi parser reads, each tagged with the agent that sent it. */
export function mergedTranscript(sessions) {
  return sessions
    .flatMap(({ agent, entries }) => entries.filter((entry) => entry.type === "message" && entry.message)
      .map((entry, index) => ({ agent, index, at: time(entry), message: entry.message })))
    .sort((a, b) => a.at - b.at || (a.agent === b.agent ? a.index - b.index : 0))
    .map(({ agent, message }) => JSON.stringify({ type: "message_end", agent, message }))
    .join("\n") + "\n";
}

const fileName = (agent) => `${agent.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").slice(0, 80) || "agent"}.jsonl`;

/** Writes a request's sessions to /out and commits them to the sessions branch with Git LFS.
 * @param {{ out: string, remote: string, log: (message: string) => void }} box
 * @param {string} requestId
 * @param {{ agent: string, entries: any[] }[]} sessions
 * @param {{ lfs?: boolean }} [options] lfs: false commits the files without LFS (tests without an LFS server)
 * @returns {{ branch?: string, commitSha?: string, files: { agent: string, path: string, sha256: string, bytes: number }[] }}
 */
export function recordSessions(box, requestId, sessions, { lfs = true } = {}) {
  const folder = join(box.out, "sessions", requestId);
  mkdirSync(folder, { recursive: true });
  const files = sessions.map(({ agent, entries }) => {
    const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(join(folder, fileName(agent)), text);
    return { agent, path: `sessions/${requestId}/${fileName(agent)}`, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) };
  });
  writeFileSync(join(folder, "transcript.jsonl"), mergedTranscript(sessions));
  if (!files.length) return { files };
  const work = mkdtempSync(join(tmpdir(), "box-sessions-"));
  try {
    const repo = join(work, "repo");
    git(work, ["clone", "--quiet", "--no-checkout", box.remote, "repo"]);
    const exists = git(repo, ["ls-remote", "--heads", "origin", SESSIONS_BRANCH]).toString().trim();
    if (exists) git(repo, ["checkout", "--quiet", "-B", SESSIONS_BRANCH, `origin/${SESSIONS_BRANCH}`]);
    else {
      git(repo, ["checkout", "--quiet", "--orphan", SESSIONS_BRANCH]);
      git(repo, ["rm", "-rfq", "--cached", "--ignore-unmatch", "."]);
    }
    if (lfs) {
      git(repo, ["lfs", "install", "--local"]);
      writeFileSync(join(repo, ".gitattributes"), "sessions/**/*.jsonl filter=lfs diff=lfs merge=lfs -text\n");
      git(repo, ["add", ".gitattributes"]);
    }
    mkdirSync(join(repo, "sessions", requestId), { recursive: true });
    for (const file of files) writeFileSync(join(repo, file.path), readFileSync(join(folder, fileName(file.agent))));
    git(repo, ["add", join("sessions", requestId)]);
    git(repo, ["commit", "--quiet", "-m", `sessions: request ${requestId}\n\n${files.map((file) => file.agent).join(", ")}`], { author: AUTHOR });
    git(repo, ["push", "--quiet", "origin", `HEAD:refs/heads/${SESSIONS_BRANCH}`]);
    return { branch: SESSIONS_BRANCH, commitSha: git(repo, ["rev-parse", "HEAD"]).toString().trim(), files };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
