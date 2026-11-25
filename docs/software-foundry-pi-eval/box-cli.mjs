#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

const cli = process.env.FOUNDRY_CONTAINER_CLI ?? "podman";
const args = process.argv.slice(2);
const socket = process.env.FOUNDRY_EVAL_TUNNEL_SOCKET;
if (socket && args[0] === "run" && args.includes("--env-file")) {
  if (!isAbsolute(socket)) throw new Error("Use an absolute inference socket path");
  // The same eval runner owns inputs, grading and cleanup. Only the provider
  // connection changes. A network-disabled box needs no published ports.
  for (let index = args.indexOf("-p"); index !== -1; index = args.indexOf("-p")) {
    args.splice(index, 2);
  }
  const image = args.pop();
  args.push(
    "--network", "none",
    "--mount", `type=bind,source=${socket},target=/run/foundry-inference.sock,ro`,
    "--mount", `type=bind,source=${join(import.meta.dirname, "box-entry.mjs")},target=/run/foundry-box-entry.mjs,ro`,
    "--entrypoint", "/usr/bin/tini",
    image, "--", "node", "/run/foundry-box-entry.mjs",
  );
}
const child = spawn(cli, args, { stdio: "inherit" });
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
