import { withBatchDocuments } from "@ai-outfitter/app-sdk/batch-documents";
import { defineDocuments, publishDocuments } from "@ai-outfitter/app-sdk/app-documents";
import { graphql } from "../../graph/graphql";
import { batchGroups } from "./batch-groups";
import { graphqlSchema } from "./graphql";

// scripts/graph-schema.ts writes these to graph/documents.json, which the platform lists
// (graph_documents) and runs by name (graph_query, graph_mutate).
const link = "id address title";
const pageDocuments = defineDocuments({
  Storyboards: {
    story: "As a producer or an agent, I want every storyboard with its brief, its shots in order and the references each shot needs, so that I can see what is planned and what is blocked.",
    document: graphql(`query Storyboards {
      storyboards {
        briefs { ${link} summary audience singleMessage claimBoundary callToAction successMetric status promotes { ${link} }
          storyboards { ${link} summary durationSeconds aspectRatio variant opening status cutFrom { ${link} }
            shots { ${link} sequence startSeconds durationSeconds beat action camera voiceover overlay sound transition sourceRoute claimStatus status
              references { ${link} status requirements fileUri version hasFile } } } }
        unbriefed { ${link} summary durationSeconds aspectRatio variant opening status cutFrom { ${link} }
          shots { ${link} sequence startSeconds durationSeconds beat action camera voiceover overlay sound transition sourceRoute claimStatus status
            references { ${link} status requirements fileUri version hasFile } } }
      }
    }`),
  },
  StageStoryboard: {
    story: "As a producer or an agent, I want to save a brief, a storyboard and its shots to our Onto as typed records, so that a member reviews them and every shot can be found by its storyboard and order.",
    document: graphql("mutation StageStoryboard($input: StageStoryboardInput!) { stageStoryboard(input: $input) { batchId state proposals storyboardId ontoPath } }"),
  },
});

export const documents = publishDocuments(withBatchDocuments(pageDocuments, graphqlSchema, batchGroups), {
  Storyboards: { description: "Read creative briefs, their storyboards, each storyboard's shots in sequence order (beat, timing, voiceover, status) and the visual references each shot needs. A reference without a file is still a requirement." },
  StoryboardChanges: { description: "Stage a creative brief, a storyboard, its shots and their visual references in the organization's Onto as one change batch a member reviews. Order and timing are properties, never title text." },
});
