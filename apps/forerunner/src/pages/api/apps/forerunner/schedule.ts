import type { APIRoute } from "astro";
import { readJSON, requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { forerunnerContext } from "../../../../server/context";
import { documents, runDocument } from "../../../../server/documents";
import { defaultSchedule, scheduleChange, scheduleDefault, scheduleStatus } from "../../../../server/schedule";

/** Whether discovery runs every morning, and on which account. */
export const GET: APIRoute = ({ request, locals }) =>
  respond(async () => ({ schedule: await scheduleStatus(workflowHost<"interactive">(locals), requestIdentity(request)) }));

/** Turn the daily run on or off: Settings runs the same SetDailyRun document agents run with graph_mutate. */
export const PUT: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const input = await readJSON(request, scheduleChange, 1024);
    const { setDailyRun } = await runDocument(documents.SetDailyRun.document, { input }, forerunnerContext(request, locals));
    return { schedule: setDailyRun };
  });

/** Turns the daily run on by default ({ timezone }); never re-enables one the member turned off. */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => ({
    schedule: await defaultSchedule(workflowHost<"interactive">(locals), requestIdentity(request), await readJSON(request, scheduleDefault, 1024)),
  }));
