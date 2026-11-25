import { defineMiddleware } from "astro:middleware";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { withPassageReviewHost } from "./server/passage-review";

export const onRequest = defineMiddleware(({ request, locals }, next) =>
  withPassageReviewHost(() => requestIdentity(request), () => workflowHost<"interactive">(locals), next));
