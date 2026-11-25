import { requireOrganization, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { AgentDatabase, AgentStatement } from "@ai-outfitter/app-sdk/agent-store";
import type { OperationInput, OperationOutput, WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { wikiPassage } from "@ai-outfitter/app-sdk/graph-contracts";

export type ReadHost = { call(operation: "actions.call", input: OperationInput<"actions.call">): Promise<OperationOutput<"actions.call">> };
export const scopeInput = z.strictObject({ wikiInstallationId: z.string().min(1).max(128) });
export const { sourcePin, wikiSource, locator, sourceInventory, sourceRead } = wikiPassage;
const { owner, verification } = wikiPassage;
export type WikiSource = z.infer<typeof wikiSource>;

export function orgId(identity: AppIdentity) {
  if (identity.callerOrganizationId || identity.role === "external")
    throw new Response("Organization access required", { status: 403 });
  return requireOrganization(identity).organizationId;
}

export function checkWikiOwner(who: AppIdentity, wiki: string, result: z.infer<typeof owner>) {
  if (result.organizationId !== orgId(who) || result.installationId !== wiki)
    throw new Response("Wiki must belong to this organization", { status: 403 });
}

export async function verifiedSources(
  host: ReadHost, who: AppIdentity, wiki: string, pins: z.infer<typeof sourcePin>[],
) {
  orgId(who);
  const result = verification.parse(await host.call("actions.call", {
    installationId: wiki, action: "passage.verify", readOnly: true, input: { sources: pins.map(({ sourceId, version }) => sourcePin.parse({ sourceId, version })) },
  }));
  checkWikiOwner(who, wiki, result);
  return new Set(result.active);
}


export type IndexScope = {
  db: AgentDatabase;
  who: AppIdentity;
  wiki: string;
  keys: [organizationId: string, wikiInstallationId: string];
};
export type Worker = IndexScope & {
  write: (...statements: AgentStatement[]) => Promise<void>;
  host: WorkflowHost<"schedule">;
  runId: string;
  startedAt: number;
};

export const statement = (sql: string, ...params: unknown[]): AgentStatement => ({ sql, params });
export const retryAt = (attempts: number) => Date.now() + Math.min(24 * 60, 2 ** Math.min(10, attempts) * 5) * 60_000;
