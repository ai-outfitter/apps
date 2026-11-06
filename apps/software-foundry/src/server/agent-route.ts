import { actionAgent } from "@ai-outfitter/app-sdk/action-agent";
import { defineAction, publishActionTools } from "@ai-outfitter/app-sdk/actions";
import { ProposalStore } from "@ai-outfitter/app-sdk/proposal-store";
import {
  agentDatabase,
  installationDatabase,
} from "@ai-outfitter/app-sdk/cloudflare/database";
import {
  requestIdentity,
  requestActor,
  requestOriginActor,
  respond,
} from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { organizationEditor, startWork, startWorkDescription, startWorkInput, startWorkOutput } from "./graph-work";
import { foundryActions, submitInput } from "./intake";
import { foundryProjects, workSubmissions } from "./schema";

/** The sidebar assistant's tools. They are named as tools for the sidebar only: the actions
 * route does not serve them as MCP tools, where agents run Foundry's documents instead. */
const sidebar = publishActionTools("software-foundry", {
  "work.get": foundryActions["work.get"],
  "work.targets": foundryActions["work.targets"],
  "work.submit": foundryActions["work.submit"],
  "work.start": defineAction({
    description: startWorkDescription, access: "write", canInvoke: organizationEditor,
    input: startWorkInput, output: startWorkOutput,
    run: startWork,
  }),
});
export function agentRoute(
  request: Request,
  operation: string,
  locals: unknown,
  internal = false,
) {
  return respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational")
      throw new Response("Read-only demo", { status: 403 });
    const identity = requestIdentity(request);
    const context = () => ({
      identity,
      actor: requestActor(request, identity),
      originActor: requestOriginActor(request, identity),
      db: () => installationDatabase(),
      host: () => workflowHost<"interactive">(locals as never),
      origin: new URL(request.url).origin,
    });
    const agent = actionAgent({
      store: new ProposalStore(agentDatabase(), identity, {
        table: "software_foundry_proposals",
        guard: "software_foundry_agent_guard",
      }),
      host: workflowHost<"interactive">(locals as never),
      type: "software-foundry.conversation",
      contextType: "software-foundry.page",
      focusId: "e9500000-0000-4000-8000-000000000003",
      label: "software-foundry",
      context,
      instructions:
        "You are the Software Foundry assistant. Explain saved submissions and delivery evidence, distinguishing recorded state from current provider state. Prepare new work for explicit review. To start work from a Wiki node, propose work.start; use work.submit only for hand-written work. Do not configure, resume, merge, or deploy work.",
      reads: {
        "work.get": sidebar["work.get"],
        "work.targets": sidebar["work.targets"],
      },
      actions: {
        "work.start": {
          retry: "same-request",
          action: sidebar["work.start"],
          prepare: (input, requestId) =>
            startWorkInput.parse({
              ...z.record(z.string(), z.unknown()).parse(input),
              requestId,
            }),
        },
        "work.submit": {
          retry: "same-request",
          action: sidebar["work.submit"],
          prepare: (input, requestId) =>
            submitInput.parse({
              ...z.record(z.string(), z.unknown()).parse(input),
              requestId,
            }),
        },
      },
      page: async () => ({
        projects: await installationDatabase()
          .select()
          .from(foundryProjects)
          .limit(30),
        submissions: await installationDatabase()
          .select({
            key: workSubmissions.key,
            repository: workSubmissions.repository,
            issue: workSubmissions.issue,
            createdAt: workSubmissions.createdAt,
          })
          .from(workSubmissions)
          .limit(20),
        source: "saved records; query the run for current execution",
      }),
    });
    return internal
      ? agent.provider(request, operation)
      : agent.browser(request, operation);
  });
}
