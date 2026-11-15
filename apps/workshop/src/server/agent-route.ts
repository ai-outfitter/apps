import { actionAgent } from "@ai-outfitter/app-sdk/action-agent";
import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { ProposalStore } from "@ai-outfitter/app-sdk/proposal-store";
import { respond } from "@ai-outfitter/app-sdk/server";
import { workshopContext } from "./context";
import { documents, runDocument } from "./documents";

export const focusId = "ed000000-0000-4000-8000-000000000001";

/** Shared private conversations, grounded in this installation's saved models and build evidence. */
export function agentRoute(request: Request, operation: string, locals: unknown, internal = false) {
  return respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational") throw new Response("Read-only demo", { status: 403 });
    const context = workshopContext(request, locals);
    const agent = actionAgent({
      store: new ProposalStore(agentDatabase(), context.identity, { table: "workshop_proposals", guard: "workshop_agent_guard" }),
      host: context.host(), type: "workshop.conversation", contextType: "workshop.page", focusId, label: "Workshop",
      context: async () => context, actions: {},
      instructions: "You are the Workshop assistant for physical product design. Help the member understand saved models, assemblies, BOM items and recorded build evaluations. Distinguish computed checks from physical validation. Explain missing evidence. You cannot modify models or start builds in this conversation; direct creation requests to New model and explain workspace build requirements for assemblies. Open a project page to discuss its parts and recorded build evidence.",
      // The assistant reads the same documents agents run over MCP: the project list, and the
      // open project's model, BOM and builds by its slug.
      page: async (view) => {
        const { workshopProjects } = await runDocument(documents.WorkshopProjects.document, {}, context);
        const projects = workshopProjects.nodes;
        const slug = /^projects\/([^/?#]+)/.exec(view?.location ?? "")?.[1];
        let detail: unknown = null;
        if (slug) {
          try {
            detail = (await runDocument(documents.WorkshopProject.document, { slug }, context)).workshopProjects.nodes[0] ?? null;
          } catch { detail = { slug, unavailable: true }; }
        }
        return { projects, detail, source:"The WorkshopProjects and WorkshopProject documents: saved project summaries and the open project's model. Physical fit is not verified." };
      },
    });
    return internal ? agent.provider(request, operation) : agent.browser(request, operation);
  });
}
