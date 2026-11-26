import { and, eq, sql } from "drizzle-orm";
import { resolveAssembly, type AssemblySource } from "../lib/assembly-resolution";
import { AssemblySchema, type AssemblyReference } from "../lib/assembly";
import type { WorkshopDatabase } from "./projects";
import { canonicalCotsPart } from "./cots-owner";
import { workshopAssemblyRevisions, workshopProjects } from "./schema";

const refuse = (message: string) => new Response(message,{status:400});
/** Capture current revision numbers in one read. Older revisions remain available
 * if a source changes while its consumer is being resolved. */
export async function assemblySnapshot(db: WorkshopDatabase, proposed?: AssemblySource, deletedId?:string) {
  const versions = Object.fromEntries((await db.select({id:workshopProjects.id,revision:workshopProjects.revision}).from(workshopProjects)).map(r=>[r.id,r.revision]));
  const cache = new Map<string,AssemblySource>();
  async function load(ref: AssemblyReference): Promise<AssemblySource> {
    if (ref.projectId===deletedId) throw new Response("Another assembly references this project", {status:409});
    if (ref.projectId===proposed?.id && (ref.revision===undefined || ref.revision===proposed.revision)) return proposed;
    const revision = ref.revision ?? versions[ref.projectId];
    if (revision===undefined) throw refuse("Referenced project does not exist in this Workshop");
    const key = ref.projectId+"/"+revision;
    const cached=cache.get(key);
    if (cached) return cached;
    const [row]=await db.select({data:workshopProjects.data}).from(workshopProjects)
      .where(and(eq(workshopProjects.id,ref.projectId),eq(workshopProjects.revision,revision)))
      .unionAll(db.select({data:workshopAssemblyRevisions.data}).from(workshopAssemblyRevisions)
        .where(and(eq(workshopAssemblyRevisions.projectId,ref.projectId),eq(workshopAssemblyRevisions.revision,revision)))).limit(1);
    if (!row) throw refuse("Referenced project revision is unavailable");
    // Tiny marker rows identify real revisions that had the same assembly as the next save.
    const snapshotRow = row.data === "null" ? await db.get<{data:string}>(sql`
      SELECT data FROM (
        SELECT revision,data FROM workshop_assembly_revisions WHERE projectId=${ref.projectId} AND revision>${revision} AND data<>'null'
        UNION ALL SELECT revision,data FROM workshop_projects WHERE id=${ref.projectId}
      ) ORDER BY revision LIMIT 1`) : row;
    if(!snapshotRow) throw refuse("Referenced project revision is unavailable");
    const record = JSON.parse(snapshotRow.data);
    const source: AssemblySource = { id:ref.projectId, revision, name:record.name,
      workspace:record.workspace, meshBuild:record.meshBuild, assembly:AssemblySchema.parse(record.assembly ?? {items:[]}) };
    cache.set(key,source);
    return source;
  }
  return {load,versions,cache};
}

export async function resolvedProject(db: WorkshopDatabase, ref: AssemblyReference) {
  const {load}=await assemblySnapshot(db);
  try { return await resolveAssembly(await load(ref),load,ref); }
  catch(error) { if(error instanceof Error) throw refuse(error.message); throw error; }
}

/** A concurrent source/consumer edit invalidates the checked graph. The guard is
 * part of the same INSERT or UPDATE that persists the new assembly. */
export async function assemblyGuard(db: WorkshopDatabase, next: AssemblySource, deleting=false) {
  const {load,versions,cache}=await assemblySnapshot(db,next,deleting ? next.id : undefined);
  const edges=await db.all<{consumer:string;source:string;pinned:number|null;kind:"assembly"|"evidence"}>(sql`
    SELECT DISTINCT p.id AS consumer, json_extract(i.value,'$.reference.projectId') AS source, json_extract(i.value,'$.reference.revision') AS pinned, 'assembly' as kind
    FROM workshop_projects p, json_each(p.data,'$.assembly.items') i
    WHERE json_extract(i.value,'$.reference.projectId') IS NOT NULL
    UNION SELECT p.id, json_extract(i.value,'$.cotsEvidenceRef.projectId'), json_extract(i.value,'$.cotsEvidenceRef.revision'), 'evidence'
    FROM workshop_projects p, json_each(p.data,'$.assembly.items') i
    WHERE json_extract(i.value,'$.cotsEvidenceRef.projectId') IS NOT NULL`);
  // A project cannot depend on itself through an alternate configuration or
  // an unplaced catalog entry, even when that branch isn't selected today.
  const dependencies = new Map<string,Set<string>>();
  for (const e of edges) {
    if (e.kind !== "assembly") continue;
    if (!dependencies.has(e.consumer)) dependencies.set(e.consumer,new Set());
    dependencies.get(e.consumer)!.add(e.source);
  }
  dependencies.set(next.id,new Set(next.assembly.items.flatMap(i=>i.reference ? [i.reference.projectId] : [])));
  const visited = new Set<string>();
  function checkCycle(id:string, path:Set<string>) {
    if(path.has(id)) throw refuse("Cross-project assembly cycle");
    if(visited.has(id)) return;
    path.add(id);
    for(const source of dependencies.get(id) ?? []) checkCycle(source,path);
    path.delete(id);
    visited.add(id);
  }
  checkCycle(next.id,new Set());
  // Historical source records can themselves contain live references absent
  // from their current version. Validate consumers of pins against the new graph.
  const affected = new Set([next.id,...edges.filter(e=>e.pinned!==null).map(e=>e.consumer)]);
  for (const id of affected) for (const e of edges) if(e.source===id) affected.add(e.consumer);
  try {
    for (const id of affected) {
      if (deleting && id===next.id) continue;
      const source = await load({projectId:id});
      if(source.assembly.items.some(i=>i.reference || i.operations?.length || i.couplings?.length)) await resolveAssembly(source,load);
      for (const item of source.assembly.items) if (item.cotsEvidenceRef) {
        await canonicalCotsPart(load, { projectId: source.id, itemId: item.id, revision: source.revision });
      }
    }
  } catch(error) { if(error instanceof Error) throw refuse(error.message); throw error; }
  const observed: Record<string,number> = {};
  for (const id of affected) if(id in versions) observed[id]=versions[id];
  for (const id of visited) if(id in versions) observed[id]=versions[id];
  for (const source of cache.values()) observed[source.id]=versions[source.id];
  // Include a consumer that linked to this graph after the snapshot. Unrelated
  // projects may change freely without invalidating a save.
  return sql`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(observed)}) v
    WHERE NOT EXISTS (SELECT 1 FROM workshop_projects p WHERE p.id=v.key AND p.revision=v.value))
    AND NOT EXISTS (SELECT 1 FROM workshop_projects p, json_each(p.data,'$.assembly.items') i
    WHERE (json_extract(i.value,'$.reference.projectId') IN (SELECT value FROM json_each(${JSON.stringify([...affected])}))
      OR json_extract(i.value,'$.reference.revision') IS NOT NULL
      OR json_extract(i.value,'$.cotsEvidenceRef.projectId') IN (SELECT value FROM json_each(${JSON.stringify([...affected])}))
      OR json_extract(i.value,'$.cotsEvidenceRef.revision') IS NOT NULL)
    AND p.id NOT IN (SELECT value FROM json_each(${JSON.stringify([...affected])})))`;

}

export const noConsumers = (id:string) => sql`NOT EXISTS (
  SELECT 1 FROM workshop_projects p, json_each(p.data,'$.assembly.items') i
  WHERE p.id<>${id} AND (json_extract(i.value,'$.reference.projectId')=${id}
    OR json_extract(i.value,'$.cotsEvidenceRef.projectId')=${id}))`;
