import { storage, type StorageLocals } from "@ai-outfitter/app-sdk/storage";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { evidenceKey, evidenceSpace } from "./demo-handoff";
import { foundryForge, hostAPI } from "./forge";
import { imageDimensions } from "./image-dimensions";
import { foundryWorkspaceWorkflow, historicalFoundryWorkspaceWorkflow } from "./workspaces";

/** A screenshot a workspace agent publishes for its pull request, as the
 * platform's publication route dispatches it to the `publish` phase. */
const foundryEvidenceInput = z.object({
  node: z.object({ runId: z.uuid(), nodeId: z.string().min(1).max(128), attemptId: z.uuid() }),
  number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/),
  filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}\.png$/),
  base64: z.base64().min(1).max(700_000),
}).strict();
const denied = () => new Response("Evidence unavailable", { status: 404 });
const publishingNodes = ["implement", "repair", "review", "review-final"];
// Checks in Actions, or in a workspace (a box, a forge without Actions).
const publishingWorkflows = [foundryWorkspaceWorkflow, historicalFoundryWorkspaceWorkflow];

/** A bounded PNG: signature, IHDR and sane dimensions. */
export function evidenceBytes(base64: string) {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  imageDimensions(bytes);
  return bytes;
}

/** The host has confirmed the attempt's live lease. Foundry checks the run and
 * node, verifies the pull request is the run's own and closes its issue (read-only
 * GraphQL the binding grants for `publish`), then stores the image publicly in
 * this installation's `runs` space for one year. */
export async function publishFoundryEvidence(host: WorkflowHost<"publish">, locals: StorageLocals, origin: string, raw: unknown) {
  const input = foundryEvidenceInput.parse(raw);
  const bytes = evidenceBytes(input.base64);
  const [loaded, repo] = await Promise.all([host.call("workflow.read", { id: input.node.runId }), host.call("repository.read", {})]);
  if (!loaded || !publishingWorkflows.includes(loaded.run.workflowId) || !publishingNodes.includes(input.node.nodeId) ||
      !loaded.attempts.some(attempt => attempt.id === input.node.attemptId && attempt.nodeId === input.node.nodeId))
    throw denied();
  const event = z.object({ issue: z.object({ number: z.number().int().positive() }), sourceRunId: z.uuid().optional() }).parse(loaded.inputs["triage.inputs.event"]);
  const forge = foundryForge(hostAPI((request) => host.call("repository.request", request)), repo);
  const branch = `outfitter/issue-${event.issue.number}-${event.sourceRunId ?? loaded.run.id}`;
  await forge.change({ number: input.number, headSha: input.headSha, branch, url: `https://github.com/${repo.name}/pull/${input.number}` },
    event.issue.number, branch, true);
  const sha256 = await sha256Hex(bytes);
  const files = storage(locals, "main");
  const ref = await files.put(evidenceSpace, evidenceKey(loaded.run.id, input.headSha, sha256, input.filename), bytes,
    { contentType: "image/png", ttl: "1y" });
  const published = await files.setVisibility(ref, "public");
  return {
    runId: loaded.run.id, headSha: input.headSha, sha256, filename: input.filename,
    ...imageDimensions(bytes),
    expiresAt: published.expiresAt, url: new URL(files.url(published), origin).href,
  };
}
