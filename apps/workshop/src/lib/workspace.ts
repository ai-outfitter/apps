import { z } from "zod";
import { AssemblySchema } from "./assembly";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().max(300).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/).refine(p => !p.split("/").includes(".."));
export const ArtifactSchema = z.object({path, sha256:hash, bytes:z.number().int().nonnegative(), contentType:z.string().max(100)}).strict();
export const BuildManifestSchema = z.object({
 version:z.literal(1), units:z.literal("mm"), sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),
 sourceHash:hash, compiler:z.string().min(1).max(300), runner:z.string().min(1).max(300),
 parameters:z.record(z.string(),z.union([z.number(),z.string(),z.boolean()])),
 assembly:AssemblySchema, artifacts:z.array(ArtifactSchema).max(300),
 tests:z.array(z.object({name:z.string().max(200),status:z.enum(["pass","fail","unverified"]),detail:z.string().max(2000)}).strict()).max(200),
 notes:z.string().max(5000), startedAt:z.iso.datetime(), finishedAt:z.iso.datetime(),
}).strict().superRefine((m,c)=>{
 const paths=new Set(m.artifacts.map(a=>a.path));
 if(!m.artifacts.some(a=>a.path.endsWith("/source.tar")&&a.sha256===m.sourceHash))c.addIssue({code:"custom",message:"Source archive must match sourceHash"});
 if(paths.size!==m.artifacts.length)c.addIssue({code:"custom",message:"Duplicate artifact path"});
 for(const i of m.assembly.items)if(i.mesh && !paths.has(i.mesh.path))c.addIssue({code:"custom",message:`Missing mesh ${i.mesh.path}`});
});
export const BuildRequestSchema=z.object({
 id:z.uuid(),repository:z.string().max(2000),sourceDir:z.string().max(300),baseRevision:z.number().int().nonnegative(),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),
 instructions:z.string().min(1).max(5000),parameters:z.record(z.string(),z.union([z.number(),z.string(),z.boolean()])),
 runner:z.string().min(1).max(300),createdAt:z.iso.datetime(),
 workflowRunId:z.uuid().optional(),
 status:z.enum(["queued","running","succeeded","failed"]),
 result:z.object({manifest:BuildManifestSchema.optional(),error:z.string().max(5000).optional(),artifactBase:z.string(),stale:z.boolean()}).optional(),
}).strict();
export const WorkspaceSchema=z.object({repository:z.string().max(2000),sourceDir:z.string().max(300).default("."),requests:z.array(BuildRequestSchema).max(100),currentBuildId:z.uuid().optional()}).strict();
export type BuildManifest=z.infer<typeof BuildManifestSchema>;
export type BuildRequest=z.infer<typeof BuildRequestSchema>;
