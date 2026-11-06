import { readFile, mkdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { gitHead } from "./git-head.mjs";
import { workflowClient } from "./client.mjs";
import { saveAttempt } from "./state.mjs";

// Invoke only in the trusted Actions adapter steps, never in the agent's process.
const [command, ...args] = process.argv.slice(2);
try {
  const directory = process.env.OUTFITTER_NODE_STATE;
  if (!directory)
    throw new Error(
      "OUTFITTER_NODE_STATE is required outside the repository checkout",
    );
  const state = resolve(directory);
  const client = workflowClient({ gateway: process.env.OUTFITTER_GATEWAY });
  const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));
  await mkdir(state, { recursive: true, mode: 0o700 });
  if (command === "claim") {
    const [runId, nodeId, attemptId] = args;
    const lease = await client.claim({ runId, nodeId, attemptId });
    await saveAttempt(resolve(state, "attempt.json"), lease);
  } else if (command === "complete") {
    await client.complete(
      (await readJSON(resolve(state, "attempt.json"))).lease,
      await readJSON(resolve(args[0])),
    );
  } else if (command === "upload") {
    const [file, key, contentType, retention = "604800"] = args;
    const headSha = gitHead();
    const artifact = await client.upload(
      (await readJSON(resolve(state, "attempt.json"))).lease,
      {
        key,
        filename: basename(file),
        contentType,
        retentionSeconds: Number(retention),
      },
      await readFile(file),
    );
    if (gitHead() !== headSha)
      throw new Error("Git HEAD changed during artifact upload");
    // Provider-neutral storage metadata stays opaque; Git evidence accompanies the package output.
    process.stdout.write(`${JSON.stringify({ artifact, headSha })}\n`);
  } else
    throw new Error(
      "Use claim <run> <node> <attempt>, complete <outputs.json>, or upload <file> <key> <content-type> [retention-seconds]",
    );
} catch {
  // Deliberately omit arbitrary fetch/response errors, which may contain URLs or credentials.
  process.stderr.write(
    `Foundry node ${command ?? "operation"} failed. No completion was asserted.\n`,
  );
  process.exitCode = 1;
}
