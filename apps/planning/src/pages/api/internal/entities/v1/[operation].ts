import type { APIRoute } from "astro";
import { intakeEntities } from "../../../../../server/intake";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { requestIdentity, requestActor, requestOriginActor } from "@ai-outfitter/app-sdk/server";
import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { entityAPI } from "@ai-outfitter/app-sdk/entities";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { planningEntities } from "../../../../../server/entities";
import { workEntities } from "../../../../../server/work-entities";
import { requestMemberIds } from "@ai-outfitter/app-sdk/members";

export const ALL: APIRoute = ({ request, params, locals }) =>
  entityAPI(request, params.operation ?? "", [
    ...planningEntities(installationDatabase(), () =>
      requestMemberIds(request),
    ),
    ...workEntities(installationDatabase()),
    ...intakeEntities(() => ({ identity: requestIdentity(request), actor: requestActor(request, requestIdentity(request)), originActor: requestOriginActor(request, requestIdentity(request)), db: () => installationDatabase(), store: () => agentDatabase(), host: () => workflowHost<"interactive">(locals) })),
  ]);
