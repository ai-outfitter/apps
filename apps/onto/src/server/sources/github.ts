import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {
  captureGithubActivity,
  githubActivityInput,
} from "@ai-outfitter/connector-github";
import { z } from "zod";

/** Onto binds portable GitHub reads to the platform's authorized connection. */
export const githubSourceInput = githubActivityInput.safeExtend({
  connectionId: z.string().min(1),
});
type Input = z.infer<typeof githubSourceInput>;
type Host = Pick<WorkflowHost<"interactive">, "call">;
/** Compatibility entry point; the connection is checked by the host on every read. */
export async function captureGithub(host: Host, raw: Input) {
  const { connectionId, ...input } = githubSourceInput.parse(raw);
  const capture = await captureGithubActivity(
    (path) =>
      host.call("repository.request", { connectionId, method: "GET", path }),
    input,
    { connectionId },
  );
  return { ...capture, provenance: { ...capture.provenance, connectionId } };
}

/** Document definition binding: config is canonical JSON persisted by the lifecycle service.
 * This provider is interactive-only because the platform does not authorize repository.request
 * with a connection in schedule phase. A scheduled caller must report the source unavailable. */
export const githubSourceProvider = "github-report";
export const githubSourceBinding = z.strictObject({
  provider: z.literal(githubSourceProvider),
  config: githubSourceInput,
});
export async function readGithubBinding(
  host: Host,
  binding: { provider: string; config: string },
) {
  if (binding.provider !== githubSourceProvider)
    throw new Response("Unknown source provider", { status: 400 });
  let config: unknown;
  try {
    config = JSON.parse(binding.config);
  } catch {
    throw new Response("Invalid GitHub source configuration", { status: 400 });
  }
  return captureGithub(host, githubSourceInput.parse(config));
}
