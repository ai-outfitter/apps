import { onPageLoad } from "@ai-outfitter/ui/page";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import {
  relationshipDetails,
  type RelationshipGraph,
} from "./relationship-cards";
import type { WikiContext } from "./wiki-context";

// Primary content is already HTML. Enhance only the selected record's graph
// with zoom/expand controls; no content reads or navigation reconstruction.
onPageLoad(() => {
  const container = document.getElementById("discovery-graph");
  const payload = document.getElementById("discovery-graph-data");
  if (!container || !payload?.textContent) return;
  try {
    const data = JSON.parse(payload.textContent) as {
      record: EntityRecord;
      graph: RelationshipGraph;
      wiki: WikiContext;
    };
    const enhanced = relationshipDetails(data.record, data.graph, data.wiki);
    container.replaceWith(enhanced);
  } catch {
    // Keep the server-rendered relationships available if enhancement fails.
  }
});
