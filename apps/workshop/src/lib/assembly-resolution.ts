import { realConfiguration } from "./inspection-links";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildPrice, type Assembly, type AssemblyReference, type Item } from "./assembly";
import { attachedMesh } from "./assembly-file";
import type { ArtifactRecord } from "./artifact";
import type { Project } from "./project";

export type AssemblySource = Pick<Project, "id"|"name"|"revision"|"assembly"|"workspace"> & {meshBuild?:{base:string;artifacts:ArtifactRecord[]}};
export type MeshSource = { base: string; artifact: ArtifactRecord };
export type ParameterDefinition = { name: string; defaultValue: number; placements: string[] };
type Configuration = NonNullable<Assembly["configurations"]>[number];

export function parameterDefinitions(assembly: Assembly, configuration?: Configuration): ParameterDefinition[] {
  const items = new Map(assembly.items.map(item => [item.id, item]));
  return (configuration?.parameters ?? []).map(parameter => ({
    name: parameter.name,
    defaultValue: parameter.defaultValue,
    placements: parameter.placements.map(binding => {
      const parent = items.get(binding.parentId);
      const use = parent?.uses.find(use => use.id === binding.usageId);
      const target = use && items.get(use.itemId);
      return [parent?.name, use?.refdes || target?.name, binding.axis.toUpperCase()].filter(Boolean).join(" / ");
    }),
  }));
}

export type ResolvedAssembly = {
  projectId: string; revision: number; assembly: Assembly; buildPrice: ReturnType<typeof buildPrice>;
  sources: { itemId: string; projectId: string; name: string; revision: number; configuration?: string; parameters?: Record<string,number>; parameterDefinitions?: ParameterDefinition[]; pinned: boolean }[];
  meshes: Record<string, MeshSource>;
  itemOrigins?: Record<string, {projectId: string; itemId: string; revision: number}>;
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
export async function resolveAssembly(root: AssemblySource, load: (ref: AssemblyReference)=>Promise<AssemblySource>, selection?: AssemblyReference, trackItemOrigins = false): Promise<ResolvedAssembly> {
  const base = configuredAssembly(root.assembly, selection);
  const items = new Map<string,Item>();
  // Legacy drives scope some usage IDs. Resolve authored paths one installation at a time.
  const usageAliases = new Map<string, (id:string)=>string>();
  const result: Omit<ResolvedAssembly,"buildPrice"> = {projectId:root.id,revision:root.revision,
    assembly:{...(base.rootId && {rootId:base.rootId}),items:[],...(base.power && {power:base.power})},sources:[],meshes:{}, ...(trackItemOrigins && {itemOrigins:{}})};
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
    const idFor = (id: string) => {
      if(id===assembly.rootId && mountId) return mountId;
      if(!scope) return id;
      // Configurations move usages. A physical part definition at the same source
      // revision is identical across configurations and has one consolidated BOM row.
      return scopedId(ids.get(id)?.kind==="assembly" ? scope : source.id+"/"+source.revision,id);
    };
    // Preserve existing paths and artifact bindings on placements outside authored drives.
    const motionUsages = new Set(assembly.items.flatMap(item=>item.driveMotion
      ? [...item.driveMotion.z.translationUsageIds,...item.driveMotion.z.rotations.map(r=>r.usageId)] : []));
    const usageIdFor = (id: string) => scope && motionUsages.has(id) ? scopedId(scope, id) : id;
    async function visit(id: string): Promise<string> {
      const viewId = idFor(id);
      if (items.has(viewId)) return viewId;
      const item = ids.get(id)!;
      if (item.reference) {
        let ref = item.reference;
        if (ancestors.has(ref.projectId)) throw Error("Cross-project assembly cycle");
        const target = await load(ref);
        if (ref.configuration && ref.revision === undefined) {
          const name = realConfiguration(target.assembly,ref.configuration);
          if (name !== ref.configuration) {
            const {Explode: _legacy, ...parameters} = ref.parameters ?? {};
            ref = {...ref,configuration:name,parameters};
          }
        }
        const configured = configuredAssembly(target.assembly,ref);
        if (!configured.rootId) throw Error(`Referenced project ${target.name} has no assembly root`);
        const configuration = target.assembly.configurations?.find(c => c.name === ref.configuration);
        const defaults = configuration?.parameters ?? [];
        const key = JSON.stringify([target.id,ref.revision??"current",ref.configuration??"",
          defaults.map(p=>[p.name,ref.parameters?.[p.name]??p.defaultValue])]);
        await expand(target,configured,key,new Set([...ancestors,target.id]),viewId);
        result.sources.push({
          itemId: viewId, projectId: target.id, name: target.name, revision: target.revision, pinned: ref.revision !== undefined,
          ...(ref.configuration && { configuration: ref.configuration }),
          ...(ref.parameters && { parameters: ref.parameters }),
          ...(defaults.length && { parameterDefinitions: parameterDefinitions(target.assembly, configuration) }),
        });
      } else {
        const view = {...item,id:viewId,uses:item.uses.map(u=>({...u,id:usageIdFor(u.id),itemId:idFor(u.itemId)}))};
        if (scope && item.driveMotion) {
          const {viewRootIds,z} = item.driveMotion;
          view.driveMotion = {...item.driveMotion,viewRootIds:viewRootIds.map(idFor),z:{...z,
            translationUsageIds:z.translationUsageIds.map(usageIdFor),
            rotations:z.rotations.map(r=>({...r,usageId:usageIdFor(r.usageId)}))}};
        }
        usageAliases.set(viewId,usageIdFor);
        items.set(viewId,view);
        if (result.itemOrigins) result.itemOrigins[viewId] = {projectId:source.id,itemId:id,revision:source.revision};
        if (scope && item.power?.loads.length) mergePower(assembly.power);
        const uploaded = attachedMesh(item);
        if (uploaded) result.meshes[viewId]=uploaded;
        else if (item.mesh) {
          const run = source.workspace?.requests.find(r=>r.id===source.workspace?.currentBuildId)?.result;
          const artifact=(source.meshBuild?.artifacts ?? run?.manifest?.artifacts)?.find(a=>a.path===item.mesh!.path);
          const base=source.meshBuild?.base ?? run?.artifactBase;
          if (artifact && base) result.meshes[viewId]={base,artifact};
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
  for (const owner of items.values()) {
    if (!owner.operations?.length) continue;
    function bind(path:string, needsJoint=false) {
      let parent = owner;
      return path.split("/").map((segment,index,parts) => {
        const [raw,copy] = segment.split("#");
        const id = usageAliases.get(parent.id)!(raw);
        const matches = parent.uses.filter(use=>use.id===id);
        const use = matches[0];
        if (matches.length!==1 || Number(copy)>=use.quantity || (needsJoint && index===parts.length-1 && !use.joint))
          throw Error(`Invalid operation path on ${owner.number}: ${path}`);
        parent = items.get(use.itemId)!;
        return id+"#"+copy;
      }).join("/");
    }
    owner.operations = owner.operations.map(op=>({...op,
      tracks: op.tracks.map(t=>({...t,path:bind(t.path,true)})),
      ...(op.handoffs && {handoffs:op.handoffs.map(e=>({...e,propPath:bind(e.propPath),...(e.carrierPath && {carrierPath:bind(e.carrierPath)})}))}),
    }));
  }
  result.assembly.items=[...items.values()];
  return {...result, buildPrice: buildPrice(result.assembly)};
}
