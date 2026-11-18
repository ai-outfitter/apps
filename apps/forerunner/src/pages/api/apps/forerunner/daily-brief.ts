import type { APIRoute } from "astro";
import { readJSON, respond } from "@ai-outfitter/app-sdk/server";
import { forerunnerContext } from "../../../../server/context";
import { documents, runDocument } from "../../../../server/documents";
import { dailyBriefScheduleInput, generateDailyBriefInput } from "../../../../server/daily-brief";
export const GET: APIRoute = ({ request, locals }) => respond(async () => runDocument(documents.DailyBriefSchedule.document, { input: {} }, forerunnerContext(request, locals)));
export const PUT: APIRoute = ({ request, locals }) => respond(async () => runDocument(documents.SetDailyBriefSchedule.document, { input: await readJSON(request, dailyBriefScheduleInput, 1024) }, forerunnerContext(request, locals)));
export const POST: APIRoute = ({ request, locals }) => respond(async () => runDocument(documents.GenerateDailyBrief.document, { input: await readJSON(request, generateDailyBriefInput, 1024) }, forerunnerContext(request, locals)));
