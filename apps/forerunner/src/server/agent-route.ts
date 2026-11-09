import { actionAgent } from "@ai-outfitter/app-sdk/action-agent";
import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { ProposalStore } from "@ai-outfitter/app-sdk/proposal-store";
import { respond } from "@ai-outfitter/app-sdk/server";
import { forerunnerContext } from "./context";
import { listItems } from "./items";

export const focusId = "eb000000-0000-4000-8000-000000000001";

/** The shared thread service runs inference; the app supplies owner-scoped board context. */
export function agentRoute(request: Request, operation: string, locals: unknown, internal = false) {
  return respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational") throw new Response("Read-only demo", { status: 403 });
    const context = forerunnerContext(request, locals);
    const agent = actionAgent({
      store: new ProposalStore(agentDatabase(), context.identity, { table: "forerunner_proposals", guard: "forerunner_agent_guard" }),
      host: context.host(),
      type: "forerunner.conversation",
      contextType: "forerunner.page",
      focusId,
      label: "Forerunner",
      context: async () => context,
      actions: {},
      instructions: "You are the Forerunner assistant. Help the member understand and prioritize their saved board, and explain what a discovery run read and proposed: read its steps with the platform WorkflowRuns and WorkflowRunSteps documents. State when information is missing. You cannot read mail directly or take external actions.",
      page: async () => {
        const items = await listItems(context.db(), context.identity);
        return {
          items: items.slice(0, 20).map(({ id, category, title, description, dueDate, status, parentId }) => ({
            id, category, title, description: description.slice(0, 300), descriptionTruncated: description.length > 300, dueDate, status, parentId,
          })),
          limited: items.length > 20,
        };
      },
    });
    return internal ? agent.provider(request, operation) : agent.browser(request, operation);
  });
}
