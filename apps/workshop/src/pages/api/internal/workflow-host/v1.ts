import type { APIRoute } from "astro";
import { workshopContext } from "../../../../server/context";
import { runDesignTask } from "../../../../server/design";
import { workspacePhases } from "../../../../server/workspace-host";
// The reserved workflow host route: only platform dispatch, with trusted props, reaches it.
// Besides the workspace phases, Workshop carries out one registered task: a design turn
// started by StartWorkshopDesign or the platform's StartTasks.
export const POST:APIRoute=({request,locals})=>workspacePhases({
  interactive:async(input,host)=>JSON.parse(JSON.stringify(await runDesignTask(workshopContext(request,locals),input,host))),
})(request,locals as never);
