import { documentWiki } from "@ai-outfitter/app-sdk/wiki-documents";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-protocol";
import { z } from "zod";
import { localDate, reviewPeriod } from "./review-period";
import type { ForerunnerContext } from "./context";
const brief = z.object({
  kind: z.literal("local-project-brief-preview"), date: z.iso.date(),
  organizations: z.array(z.object({ slug: z.string().regex(/^[a-z0-9-]+$/), name: z.string(), projects: z.array(z.object({ projectId: z.string().uuid().optional(), name: z.string(), update: z.string() })) })),
});
/** Owner-scoped Wiki previews remain separate from measured daily report evidence. */
export async function readBriefPreview(context: ForerunnerContext, date: string, weekly = false, timezone = "America/Chicago") {
  const host = context.host();
  const wiki = await documentWiki(host);
  const query = async (query: string, variables: Record<string, string | number>) => {
    const result = graphGraphqlResult.parse(await host.call("actions.call", { installationId: wiki.installationId, action: "graph.graphql", readOnly: true, input: { query, variables, maxBytes: 65536 } }));
    if (query.includes("BriefPage(") && result.errors?.length && result.errors.every(error => /Page not found/.test(error.message))) return { page: null };
    if (result.errors?.length || result.extensions?.truncated || !result.data) throw new Error("Brief unavailable");
    return result.data;
  };
  const page = await query("query BriefPage($slug:String!){page(slug:$slug){documentId}}", { slug: `forerunner-${weekly ? "week" : "day"}-${date}` });
  if (!page.page) return null;
  const { documentId } = z.object({ documentId: z.string() }).parse(page.page);
  let revision: number | undefined;
  if (date < localDate(Date.now(), timezone)) {
    const history = await query("query BriefHistory($id:ID!){documentRevisions(id:$id){revision createdAt}}", { id: documentId });
    const revisions = z.array(z.object({ revision: z.number(), createdAt: z.string() })).parse(history.documentRevisions).sort((a,b) => a.revision - b.revision);
    const end = reviewPeriod({ date, timezone }).end;
    // A completed day reads its last pre-midnight revision, never today's edits.
    // Historical mock/backfill documents start with their first saved snapshot.
    revision = revisions.filter(item => Number(item.createdAt) < end).at(-1)?.revision ?? revisions[0]?.revision;
  }
  const result = await query("query Brief($id:ID!,$revision:Int){document(id:$id,revision:$revision){generatedBody archived}}", { id: documentId, ...(revision ? { revision } : {}) });
  const document = z.object({ generatedBody: z.string(), archived: z.boolean() }).parse(result.document);
  if (document.archived) return null;
  const parsed = brief.parse(JSON.parse(document.generatedBody));
  if (parsed.date !== date) return null;
  // Resolve navigation metadata from the current document without changing the frozen prose.
  if (revision && parsed.organizations.some(org => org.projects.some(project => !project.projectId))) {
    const head = await query("query BriefLinks($id:ID!){document(id:$id){generatedBody}}", { id: documentId });
    const current = brief.parse(JSON.parse(z.object({ generatedBody: z.string() }).parse(head.document).generatedBody));
    for (const org of parsed.organizations) for (const project of org.projects) {
      const matches = current.organizations.find(item => item.slug === org.slug)?.projects.filter(item => item.name === project.name) ?? [];
      if (!project.projectId && matches.length === 1) project.projectId = matches[0].projectId;
    }
  }
  return parsed;
}
