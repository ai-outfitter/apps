import type { APIRoute } from "astro";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { readJSON, requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { describeWorkshopProject } from "../../../../../../server/projects";

export const PATCH: APIRoute = ({ params, request }) => respond(async () => {
  const input = await readJSON(request, z.strictObject({revision:z.int().nonnegative(),purpose:z.enum(["product","component"])}), 1024);
  return describeWorkshopProject(installationDatabase(), requestIdentity(request), {id:params.id ?? "", ...input});
});
