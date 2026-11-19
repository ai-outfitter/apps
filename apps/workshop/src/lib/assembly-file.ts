import { z } from "zod";

const types = {stl:"model/stl", step:"model/step", stp:"model/step", mp4:"video/mp4", webm:"video/webm", gif:"image/gif"} as const;
export const fileName = z.string().max(160).regex(/^[a-z0-9_][a-z0-9_.-]*\.(stl|step|stp|mp4|webm|gif)$/i);
export const assemblyFile = z.object({
  projectId:z.uuid(), fileName, sha256:z.string().regex(/^[a-f0-9]{64}$/), bytes:z.number().int().min(1).max(25*1024*1024),
}).strict();
export type AssemblyFile = z.infer<typeof assemblyFile>;
export function fileType(name:string) { return types[name.split(".").at(-1)!.toLowerCase() as keyof typeof types]; }
export const filePath = (f:AssemblyFile) => f.sha256+"/"+f.fileName;
export const fileBase = (f:AssemblyFile) => "/files/main/builds/"+f.projectId+"/assembly/";

export function attachedMesh(item:{mesh?:{path:string}; files?:AssemblyFile[]}) {
  const file=item.files?.find(f=>filePath(f)===item.mesh?.path);
  if (file) return {base:fileBase(file),artifact:{path:filePath(file),sha256:file.sha256,bytes:file.bytes}};
}
