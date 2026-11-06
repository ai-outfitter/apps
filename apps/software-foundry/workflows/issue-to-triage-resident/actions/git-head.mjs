import { execFileSync } from "node:child_process";
/** Never accept the model's transcription of a commit identifier. */
export function gitHead(cwd = process.cwd()) {
  const value = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(value))
    throw new Error("Cannot read actual Git HEAD");
  return value;
}
