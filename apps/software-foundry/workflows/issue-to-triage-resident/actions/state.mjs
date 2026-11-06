import { writeFile, link, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { engineerContext } from "./context.mjs";
/** Publish one complete state file atomically, without replacing an existing attempt. */
export async function saveAttempt(path, lease) {
  const content = JSON.stringify({ lease, context: engineerContext(lease) });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
