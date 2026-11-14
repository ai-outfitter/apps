import { documentWiki } from "@ai-outfitter/app-sdk/wiki-documents";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-protocol";
import { z } from "zod";
import { planningContext } from "./context";

const previewSchema = z.object({
  kind: z.literal("project-conversation-preview"), projectId: z.string().uuid(), date: z.string(),
  milestone: z.string(), today: z.string(), yesterday: z.string(), lastWeek: z.string(), question: z.string(),
  goals: z.array(z.object({ title: z.string(), kind: z.enum(["checkpoint", "outcome"]), target: z.number().positive(), unit: z.string(), evidence: z.string() })).max(4),
});
export type ProjectConversationPreview = z.infer<typeof previewSchema>;
/** Explicit opt-in design documents, scoped through the installation's Wiki. Never a metric observation. */
export async function readProjectConversationPreview(request: Request, locals: unknown, projectId: string) {
  const host = planningContext(request, locals).host();
  const wiki = await documentWiki(host);
  const query = async (query: string, variables: Record<string, string>) => {
    const response = graphGraphqlResult.parse(await host.call("actions.call", { installationId: wiki.installationId, action: "graph.graphql", readOnly: true, input: { query, variables, maxBytes: 16384 } }));
    if (response.errors?.length || response.extensions?.truncated) return null;
    return response.data;
  };
  const page = await query("query PreviewPage($slug:String!){page(slug:$slug){documentId}}", { slug: `project-conversation-preview-${projectId}` });
  const id = z.object({ page: z.object({ documentId: z.string() }).nullable() }).safeParse(page);
  if (!id.success || !id.data.page) return null;
  const result = await query("query PreviewDocument($id:ID!){document(id:$id){generatedBody archived}}", { id: id.data.page.documentId });
  const document = z.object({ document: z.object({ generatedBody: z.string(), archived: z.boolean() }) }).safeParse(result);
  if (!document.success || document.data.document.archived) return null;
  const parsed = previewSchema.safeParse(JSON.parse(document.data.document.generatedBody));
  return parsed.success && parsed.data.projectId === projectId ? parsed.data : null;
}
