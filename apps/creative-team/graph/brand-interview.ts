import type { AuthoredGraph } from "@ai-outfitter/app-sdk/graph-authoring";
import { z } from "zod";
import { schemaJSON } from "@ai-outfitter/app-sdk/agent-schema";
/** A Wiki record the interview names: an existing one (existingId) or one this batch creates. */
const nodeRef = (title: string) => z.uuid().meta({ "x-wiki-reference": "node", title });

/** The BrandInterview body. Answers stay in the member's words; mentions point at Wiki records. */
export const interviewDocument = z.strictObject({
  schemaVersion: z.literal(1),
  subject: nodeRef("Whose brand").describe("The Person whose brand this is: the member."),
  sections: z.array(z.strictObject({
    id: z.string().max(64),
    title: z.string().max(200),
    answers: z.array(z.strictObject({
      questionId: z.string().max(64),
      question: z.string().max(500),
      answer: z.string().max(8000).describe("The member's answer, in their own words."),
      mentions: z.array(nodeRef("Mentioned record")).max(20).describe("Wiki records this answer names: people, audiences, problems, offerings, goals."),
    })).max(40),
  })).max(20),
});
export type InterviewDocument = z.infer<typeof interviewDocument>;

/** Stable IDs: the same in every Wiki, so setup is add-only and repeatable. */
export const wikiTypeIds = {
  interview: "c7ea0000-0000-4000-8000-000000000101",
  interviewOf: "c7ea0000-0000-4000-8000-000000000102",
  mentions: "c7ea0000-0000-4000-8000-000000000103",
  influencedBy: "c7ea0000-0000-4000-8000-000000000104",
  servesAudience: "c7ea0000-0000-4000-8000-000000000105",
} as const;
const edgeType = (id: string, name: string, title: string, body: string, from: string[], to: string[] | "any") =>
  ({ id, category: "edge" as const, name, title, body, properties: [], ontology: { version: 2 as const, endpoints: { from, to } } });
export const brandWikiTypes = {
  types: [
    { id: wikiTypeIds.interview, category: "node", name: "BrandInterview", title: "Brand interview", properties: [], jsonSchema: schemaJSON(interviewDocument),
      body: "A member's personal brand interview from the Creative team app: their answers to the intellectual-signature questions, in their own words, with the people, audiences, problems, offerings and goals each answer names." },
    edgeType(wikiTypeIds.interviewOf, "brand_interview_of", "Brand interview of", "The Person whose brand the interview describes.", ["creative-team:BrandInterview"], ["onto:Person"]),
    edgeType(wikiTypeIds.mentions, "brand_interview_mentions", "Mentioned in brand interview", "A record the member named in a brand interview answer. Says the member mentioned it, nothing more.", ["creative-team:BrandInterview"], ["onto:Person", "onto:CustomerSegment", "onto:Problem", "onto:Offering", "planning:Goal"]),
    edgeType(wikiTypeIds.influencedBy, "influenced_by", "Influenced by", "A person whose work shaped this person's thinking, as they said themselves.", ["onto:Person"], ["onto:Person"]),
    edgeType(wikiTypeIds.servesAudience, "serves_audience", "Serves audience", "An audience this person makes content and offers for, as they described it.", ["onto:Person"], ["onto:CustomerSegment"]),
  ],
  nodes: [], edges: [],
} satisfies Pick<AuthoredGraph, "types" | "nodes" | "edges">;
