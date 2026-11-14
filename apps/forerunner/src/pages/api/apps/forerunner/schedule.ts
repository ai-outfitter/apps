import type { APIRoute } from "astro";
import { z } from "zod";
import { readJSON, requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { forerunnerContext } from "../../../../server/context";
import { defaultDailyBriefSchedule } from "../../../../server/daily-brief";
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

/**
 * Turns the defaults on ({ timezone }, the device's time zone): daily discovery
 * for a readable account, and the 05:00 daily brief of a personal installation.
 * Neither re-enables or changes a schedule the member already saved. Without a
 * time zone no daily brief schedule is created, so it never runs on a guessed day.
 */
export const POST: APIRoute = ({ request, locals }) =>
  respond(async () => {
    const host = workflowHost<"interactive">(locals), who = requestIdentity(request);
    const { timezone } = await readJSON(request, z.strictObject({ timezone: z.string().max(64).optional() }), 1024);
    const schedule = await defaultSchedule(host, who, scheduleDefault.parse({ timezone }), installationDatabase());
    // A refused or failed brief default must not hide the discovery status the page asked for.
    if (timezone) await defaultDailyBriefSchedule(host, who, timezone).catch(() => null);
    return { schedule };
  });
