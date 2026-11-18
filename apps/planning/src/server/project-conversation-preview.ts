import { readWikiPage } from "@ai-outfitter/app-sdk/wiki-documents";
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
  const document = await readWikiPage(host, `project-conversation-preview-${projectId}`).catch(() => null);
  if (!document || document.archived) return null;
  const parsed = previewSchema.safeParse(JSON.parse(document.generatedBody));
  return parsed.success && parsed.data.projectId === projectId ? parsed.data : null;
}
