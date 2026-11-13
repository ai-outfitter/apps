import { actionAgent } from "@ai-outfitter/app-sdk/action-agent";
import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { ProposalStore } from "@ai-outfitter/app-sdk/proposal-store";
import { respond } from "@ai-outfitter/app-sdk/server";
import { workshopContext } from "./context";
import { slugId } from "../lib/sections";
import { getWorkshopProject, listWorkshopProjects } from "./projects";

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
      page: async (view) => {
        const projects = await listWorkshopProjects(context.db());
        const slug = /^projects\/([^/?#]+)/.exec(view?.location ?? "")?.[1];
        const suffix = slug ? slugId(slug) : undefined;
        const selected = suffix ? projects.find(p => p.id.endsWith(suffix)) : undefined;
        let detail: unknown = null;
        if (selected) {
          try {
            const p = await getWorkshopProject(context.db(), selected.id);
            const build = p.workspace?.requests.find(run => run.id === p.workspace?.currentBuildId);
            const assembly = build?.result?.manifest?.assembly ?? p.assembly;
            detail = { id:p.id, brief:p.brief.slice(0,2000), requirements:p.requirements.slice(0,2000),
              items:assembly.items.slice(0,50).map(({id,name,number,kind,unitCost,priceKnown})=>({id,name,number,kind,unitCost,priceKnown})), itemsLimited:assembly.items.length>50,
              build:build ? {id:build.id,status:build.status,notes:build.result?.manifest?.notes.slice(0,1000),
                tests:build.result?.manifest?.tests.slice(0,30).map(test=>({...test,detail:test.detail.slice(0,300)})),testsLimited:(build.result?.manifest?.tests.length??0)>30} : null };
          } catch { detail={id:selected.id,unavailable:true}; }
        }
        return { projects, detail, source:"Saved project summaries and bounded detail for the open project. Physical fit is not verified." };
      },
    });
    return internal ? agent.provider(request, operation) : agent.browser(request, operation);
  });
}
