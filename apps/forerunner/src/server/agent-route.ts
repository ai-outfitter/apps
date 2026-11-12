import { actionAgent } from "@ai-outfitter/app-sdk/action-agent";
import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { ProposalStore } from "@ai-outfitter/app-sdk/proposal-store";
import { respond } from "@ai-outfitter/app-sdk/server";
import { forerunnerContext } from "./context";
import { getPreview } from "./discovery";
import { planningIntakeTools } from "./planning-intake";
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
      actions: { "discovery.planning-intake": { action: planningIntakeTools["discovery.planning-intake"], retry: "same-request", prepare: (input: unknown) => input } },
      reads: { "discovery.planning-candidates": planningIntakeTools["discovery.planning-candidates"] },
      instructions: "You are the Forerunner assistant. Help the member understand and prioritize their saved board, and explain what a discovery run read and proposed: read its steps with the platform WorkflowRuns and WorkflowRunSteps documents. State when information is missing. For a saved discovered need, read current Planning candidates, ask the member which need and existing Planning project to use, and prepare the owner-scoped Planning intake proposal for explicit review. Corrections supersede old matches; never copy source samples or infer an organization from membership. A confirmed intake starts the existing Planning discovery and release-fit conversation, not delivery. You cannot read mail directly.",
      page: async () => {
        const items = await listItems(context.db(), context.identity);
        const preview = context.identity.canEdit ? await getPreview(context.db(), context.identity) : null;
        return {
          items: items.slice(0, 20).map(({ id, category, title, description, dueDate, status, parentId }) => ({
            id, category, title, description: description.slice(0, 300), descriptionTruncated: description.length > 300, dueDate, status, parentId,
          })),
          limited: items.length > 20,
          discovery: preview ? { previewId: preview.id, saved: Boolean(preview.savedAt && preview.receipt), destination: preview.destination, sourceCount: preview.sources.length } : null,
          ownerScope: context.identity.owner,
          nextAction: "Select a saved canonical need for Planning; review its current match and destination before capture.",
        };
      },
    });
    return internal ? agent.provider(request, operation) : agent.browser(request, operation);
  });
}
