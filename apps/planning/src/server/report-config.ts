import type {WorkflowHost} from "@ai-outfitter/app-sdk/workflow-host";
import {digestWorkflow} from "./digests";
import {previousReportPeriod,reportTimezone} from "./report-period";

/** Read this owner's persisted report calendar configuration; an unavailable read is never a guessed period. */
export async function configuredReportPeriod(host:Pick<WorkflowHost<"interactive">,"call">,at=Date.now()){
 const schedule=(await host.call("schedules",{})).find(row=>row.workflowId===digestWorkflow);
 const timezone=typeof schedule?.inputs.timezone==="string"?schedule.inputs.timezone:schedule?.timezone??reportTimezone;
 return previousReportPeriod(at,timezone);
}
