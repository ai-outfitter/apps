import type { APIRoute } from "astro";
import { respond } from "@ai-outfitter/app-sdk/server";
import { foundryContext } from "../../../../server/context";
import { uploadReleaseEvidence } from "../../../../server/release-evidence";

// The upload URL SubmitReleaseEvidence hands out: the same signed-in editor PUTs the declared bytes here.
export const PUT: APIRoute = ({ request, locals, params }) =>
  respond(() => uploadReleaseEvidence(foundryContext(request, locals), params.token ?? "", request));
