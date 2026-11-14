/** Registered manual task: exactly the Sources → Rerun read/analyze/save path. */
import { taskInvocation, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { previewDiscovery, previewInput } from "./discovery";
import { discoveryWorkflow } from "./schedule";
import type { Database } from "./items";
export async function runDiscoveryTask(db: Database, who: AppIdentity, input: PhaseInput, host: WorkflowHost<"interactive">): Promise<PhaseInput> {
  requireEditor(who);
  const invocation = taskInvocation.parse(input);
  if (invocation.task !== discoveryWorkflow) throw new Response("Unknown registered task", {status:404});
  const request = previewInput.parse(invocation.inputs);
  let lastStatus: string | undefined;
  const preview = await previewDiscovery(db,who,host,request,true,{
    taskId: invocation.runId,
    progress: async event => {
      const status = String(event.status);
      if (status === lastStatus || !["preparing","reading","analyzing","saving"].includes(status)) return;
      lastStatus = status;
      await host.call("workflow.collect",{runId:invocation.runId,slot:"analyze.outputs.result",value:{status,entries:0},complete:false});
    },
  });
  const result = {status:"ready",entries:preview.entries.length,previewId:preview.id,...(preview.savedAt ? {savedAt:preview.savedAt} : {}),...(preview.batch ? {batchId:preview.batch.batchId} : {})};
  // Retain completion before returning: a lost phase response is reconciled by the host.
  await host.call("workflow.collect",{runId:invocation.runId,slot:"analyze.outputs.result",value:result});
  return result;
}
