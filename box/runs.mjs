#!/usr/bin/env node
// The boxes eval runs kept (box/eval/agent.ts keeps each run's /box in a named
// volume): list them, reopen one to look around its Forgejo and platform as
// the run left them, and remove them when done.
//
//   node box/runs.mjs list
//   node box/runs.mjs open <volume> [--port 8787] [--forgejo-port 3300] [--image <ref>]
//   node box/runs.mjs rm <volume>... | --all
//
// BOX_CLI picks the container CLI (podman by default here, as the evals use).
import { spawn, spawnSync } from "node:child_process";

const cli = process.env.BOX_CLI || "podman";
const [command, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : fallback;
};
const run = (args) => {
  const result = spawnSync(cli, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cli} ${args[0]} ${args[1] ?? ""} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

/** Every kept run's volume with its labels, newest first. */
function kept() {
  const names = run(["volume", "ls", "--filter", "label=outfitter.box.run", "--format", "{{.Name}}"]).split("\n").filter(Boolean);
  return names.map((name) => ({ name, labels: JSON.parse(run(["volume", "inspect", "--format", "{{json .Labels}}", name])) }))
    .sort((a, b) => b.labels["outfitter.box.run"].localeCompare(a.labels["outfitter.box.run"]));
}

if (command === "list") {
  const volumes = kept();
  if (!volumes.length) console.log("No kept runs.");
  for (const { name, labels } of volumes) console.log(`${name}\n  ${labels["outfitter.box"]} ${labels["outfitter.box.eval"]}, image ${labels["outfitter.box.image"]}`);
} else if (command === "open") {
  const [volume] = rest;
  if (!volume || volume.startsWith("--")) throw new Error("Usage: node box/runs.mjs open <volume> [--port 8787] [--forgejo-port 3300] [--image <ref>]");
  const labels = JSON.parse(run(["volume", "inspect", "--format", "{{json .Labels}}", volume]));
  const port = flag("port", "8787"), forgejoPort = flag("forgejo-port", "3300");
  const image = flag("image", labels["outfitter.box.image"]);
  // The platform answers only at its own origin (outfitter.localhost:8787), and the links a run wrote name
  // the box's ports (8787, 3300): other host ports serve Forgejo, but the platform only on 8787.
  console.log(`Reopening ${volume} (${image}). Platform: http://outfitter.localhost:${port}${port === "8787" ? "" : " (answers only when published on 8787)"} (local@example.test / local-orgs-only),`
    + ` Forgejo: http://127.0.0.1:${forgejoPort} (box-admin; password: ${cli} exec <container> cat /box/secrets/forgejo-box-admin-password).`
    + " Nothing is filed or ticked; Ctrl-C stops it and keeps the volume.");
  const child = spawn(cli, ["run", "--rm", "--name", `${volume}-open`, "-p", `127.0.0.1:${port}:8787`, "-p", `127.0.0.1:${forgejoPort}:3300`,
    "-e", "BOX_REOPEN=1", "-v", `${volume}:/box`, image], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => spawnSync(cli, ["stop", "-t", "5", `${volume}-open`]));
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (command === "rm") {
  const volumes = rest.includes("--all") ? kept().map(({ name }) => name) : rest;
  if (!volumes.length) throw new Error("Usage: node box/runs.mjs rm <volume>... | --all");
  for (const volume of volumes) {
    run(["volume", "rm", volume]);
    console.log(`removed ${volume}`);
  }
} else {
  console.log("Usage: node box/runs.mjs list | open <volume> [--port 8787] [--forgejo-port 3300] [--image <ref>] | rm <volume>... | --all");
  process.exit(command ? 1 : 0);
}
