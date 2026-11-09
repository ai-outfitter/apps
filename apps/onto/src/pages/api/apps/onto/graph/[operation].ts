import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { entityAPI } from "@ai-outfitter/app-sdk/entities";
import { requestIdentity, respond } from "@ai-outfitter/app-sdk/server";
import type { APIRoute } from "astro";
import { graphBundle } from "../../../../../lib/graph-export";
import { wikiHome } from "../../../../../server/wiki-home";
import { readGraph } from "../../../../../server/graph";
import { transferableGraph } from "../../../../../server/graph-transfer";
import { graphAssertionConfirmations } from "../../../../../server/schema";
import { graphEntities } from "../../../../../server/graph-entities";

// The browser's adapter over the same entity operations. Only the platform
// dispatcher verifies cross-app references, so this one cannot establish them.
export const ALL: APIRoute = async ({ request, params }) => {
  const db = installationDatabase();
  const reading = request.method === "GET";
  if (params.operation === "snapshot" && reading)
    return respond(async () => {
      const who = requestIdentity(request);
      const graph = await readGraph(db, who);
      return { ...graph, home: wikiHome(graph, who) };
    });
  if (params.operation === "export" && reading)
    return respond(async () => {
      const who = requestIdentity(request);
      const graph = await readGraph(db, who);
      const confirmations = await db.select().from(graphAssertionConfirmations);
      const portable = transferableGraph(graph);
      return {
        ...graphBundle(graph),
        ...portable,
        confirmationArchive: {
          format: "outfitter-wiki-confirmations-v1",
          installationId: who.installationId,
          owner: who.owner,
          confirmations,
        },
        transferLimitations: [
          ...portable.transferLimitations,
          ...(confirmations.length
            ? [
                "Authenticated confirmation receipts are retained in the audit archive but cannot be imported as approvals into another installation.",
              ]
            : []),
        ],
      };
    });
  return entityAPI(
    request,
    params.operation ?? "",
    graphEntities(db, { verifiedReferences: false }),
  );
};
