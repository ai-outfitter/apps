import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Assembly, AssemblyReference, Item } from "./assembly";
import type { ArtifactRecord } from "./artifact";
import type { Project } from "./project";

export type AssemblySource = Pick<Project, "id"|"name"|"revision"|"assembly"|"workspace">;
export type MeshSource = { base: string; artifact: ArtifactRecord };
export type ResolvedAssembly = {
  projectId: string; revision: number; assembly: Assembly;
  sources: { itemId: string; projectId: string; name: string; revision: number; configuration?: string; pinned: boolean }[];
  meshes: Record<string, MeshSource>;
};
export function configuredAssembly(source: Assembly, ref?: AssemblyReference) {
  const config = source.configurations?.find(c => c.name === ref?.configuration);
  if (ref?.configuration && !config) throw Error(`Unknown assembly configuration: ${ref.configuration}`);
  const parameters = config?.parameters ?? [];
  for (const key of Object.keys(ref?.parameters ?? {}))
    if (!parameters.some(p=>p.name===key)) throw Error(`Unknown configuration parameter: ${key}`);
  if (!config) return source;
  const assembly = structuredClone(source);
  assembly.rootId = config.rootId;
  const byId = new Map(assembly.items.map(i=>[i.id,i]));
  for (const p of parameters) {
    const value = ref?.parameters?.[p.name] ?? p.defaultValue;
    if (value < p.min || value > p.max) throw Error(`${p.name} must be between ${p.min} and ${p.max}`);
    for (const binding of p.placements) {
      const use = byId.get(binding.parentId)!.uses.find(u=>u.id===binding.usageId)!;
      use.position["xyz".indexOf(binding.axis)] = value * binding.scale + binding.offset;
    }
  }
  return assembly;
}

function scopedId(scope: string, id: string) {
  const hash = bytesToHex(sha256(new TextEncoder().encode(scope + "/" + id)));
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}

/** Expand references for display only. Local item IDs stay usable as deep links.
 * Instances retain usage quantities. Each configured source definition is emitted once. */
export async function resolveAssembly(root: AssemblySource, load: (ref: AssemblyReference)=>Promise<AssemblySource>, selection?: AssemblyReference): Promise<ResolvedAssembly> {
  const base = configuredAssembly(root.assembly, selection);
  const items = new Map<string,Item>();
  const result: ResolvedAssembly = {projectId:root.id,revision:root.revision,
    assembly:{rootId:base.rootId,items:[],power:base.power},sources:[],meshes:{}};
  function mergePower(power: Assembly["power"]) {
    if (!power) return;
    const current = result.assembly.power;
    if (!current) { result.assembly.power = structuredClone(power); return; }
    if (current.scenarios.length !== power.scenarios.length || power.scenarios.some(s=>!current.scenarios.some(t=>t.id===s.id)))
      throw Error("Referenced power scenarios must share the consumer's scenario IDs");
    if (power.rails.find(r=>!r.parent)?.id !== current.rails.find(r=>!r.parent)?.id)
      throw Error("Referenced power rails must share a source boundary");
    for (const rail of power.rails) {
      const existing=current.rails.find(r=>r.id===rail.id);
      if (!existing) { result.assembly.power={...result.assembly.power!,rails:[...result.assembly.power!.rails,rail]}; continue; }
      if (existing.parent!==rail.parent || existing.kind!==rail.kind || existing.voltage!==rail.voltage || existing.efficiency!==rail.efficiency)
        throw Error(`Incompatible referenced power rail: ${rail.id}`);
    }
  }
  async function expand(source: AssemblySource, assembly: Assembly, scope: string, ancestors: Set<string>, mountId?: string) {
    const ids = new Map(assembly.items.map(i=>[i.id,i]));
    const idFor = (id: string) => id === assembly.rootId && mountId ? mountId : scope ? scopedId(scope,id) : id;
    async function visit(id: string): Promise<string> {
      const viewId = idFor(id);
      if (items.has(viewId)) return viewId;
      const item = ids.get(id)!;
      if (item.reference) {
        const ref = item.reference;
        if (ancestors.has(ref.projectId)) throw Error("Cross-project assembly cycle");
        const target = await load(ref);
        const configured = configuredAssembly(target.assembly,ref);
        if (!configured.rootId) throw Error(`Referenced project ${target.name} has no assembly root`);
        const key = JSON.stringify([target.id,ref.revision??"current",ref.configuration??"",Object.entries(ref.parameters??{}).sort()]);
        await expand(target,configured,key,new Set([...ancestors,target.id]),viewId);
        result.sources.push({itemId:viewId,projectId:target.id,name:target.name,revision:target.revision,configuration:ref.configuration,pinned:ref.revision!==undefined});
      } else {
        const view = {...item,id:viewId,uses:item.uses.map(u=>({...u,itemId:idFor(u.itemId)}))};
        items.set(viewId,view);
        if (scope && item.power?.loads.length) mergePower(assembly.power);
        if (scope && item.mesh) {
          const run = source.workspace?.requests.find(r=>r.id===source.workspace?.currentBuildId)?.result;
          const artifact=run?.manifest?.artifacts.find(a=>a.path===item.mesh!.path);
          if (artifact && run) result.meshes[viewId]={base:run.artifactBase,artifact};
        }
        for (const use of item.uses) await visit(use.itemId);
      }
      return viewId;
    }
    const rootId = assembly.rootId ? await visit(assembly.rootId) : undefined;
    if (!scope && !selection?.configuration) for (const item of assembly.items) await visit(item.id);
    return rootId;
  }
  await expand(root,base,"",new Set([root.id]));
  result.assembly.items=[...items.values()];
  return result;
}
