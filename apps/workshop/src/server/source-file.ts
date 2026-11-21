import { z } from "zod";
import type { WorkshopContext } from "./graphql";

export const repositoryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const sourceFileInput = z.object({
  repository: repositoryName,
  path: z.string().min(1).max(1024).refine(path => path.split("/").every(segment =>
    segment !== "." && segment !== ".." && /^[A-Za-z0-9_. -]+$/.test(segment))),
  ref: z.string().min(1).max(255),
});
const file = z.object({ type:z.literal("file"), encoding:z.literal("base64"), content:z.string(),
  sha:z.string().regex(/^[a-f0-9]{40}$/), size:z.number().int().nonnegative(), path:z.string() });

export async function readSourceFile(context:WorkshopContext, input:z.infer<typeof sourceFileInput>) {
  const host=context.host();
  const {connections}=await host.call("snapshot",{});
  const matches=connections.filter(c=>c.provider==="forgejo" && c.repositories.some(r=>r.toLowerCase()===input.repository.toLowerCase()));
  if(matches.length!==1) throw new Response("One connected Forgejo repository is required",{status:409});
  const path=input.path.split("/").map(encodeURIComponent).join("/");
  const entry=file.parse(await host.call("repository.request",{connectionId:matches[0].id,
    path:`/repos/${input.repository.toLowerCase()}/contents/${path}?ref=${encodeURIComponent(input.ref)}`}));
  if(entry.path!==input.path || atob(entry.content).length!==entry.size)throw new Response("Incomplete source file",{status:502});
  return {repository:input.repository,ref:input.ref,...entry};
}
