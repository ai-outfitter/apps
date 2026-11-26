import { JointSchema, OperationSchema } from "./operation-schema";
import { SavedDriveMotionSchema } from "./drive-motion-schema";
import { z } from "zod";
import { cotsEvidence, cotsEvidenceRef } from "./cots-evidence";
import { assemblyFile } from "./assembly-file";
import { ArtifactPathSchema } from "./artifact";
import { ItemPowerSchema, PowerSystemSchema, validateAssemblyPower } from "./power";
import { Matrix4, Euler, Quaternion, Vector3 } from "three";
import { type CadPlan, AssemblyCadPlanSchema, planBounds } from "../model/cad-plan";

// A product structure in the shape Windchill and Teamcenter use: items (part
// masters with one current revision) and usage lines from an assembly item to
// the items it contains. An assembly line can point at another assembly, which
// makes a sub-assembly. Firmware is an item too, so the BOM lists the software
// a build needs alongside its hardware.

const url = z
  .string()
  .max(2000)
  .refine((s) => !s || /^https?:\/\//i.test(s), "Use an http or https URL");
const coordinate = z.number().min(-10000).max(10000);

export const meshBounds = z.object({min:z.tuple([coordinate,coordinate,coordinate]),max:z.tuple([coordinate,coordinate,coordinate])}).refine(b=>b.min.every((n,i)=>n<=b.max[i]),"Invalid mesh bounds");

export const UsageSchema = z
  .object({
    id: z.uuid(),
    itemId: z.uuid(),
    joint: JointSchema.optional(),
    explode: z.object({
      /** Inspection-only translation in parent coordinates, in mm. */
      offset: z.tuple([coordinate, coordinate, coordinate]).optional(),
      step: z.number().int().min(1).max(100).optional(),
      fixed: z.literal(true).optional(),
      /** Keep descendants assembled even when inspecting this occurrence. */
      rigid: z.boolean().optional(),
    }).refine(
      ({ offset, step, fixed }) => fixed ? offset === undefined && step === undefined : offset !== undefined,
      "Specify an explode offset with an optional step, or fixed: true by itself. Rigid is optional in either case.",
    ).optional(),
    quantity: z.number().int().min(1).max(1000),
    /** Reference designators or a find number, such as "U1" or "Find 3". */
    refdes: z.string().trim().max(60).default(""),
    /** Where the item's origin sits in the parent assembly, in mm. */
    position: z.tuple([coordinate, coordinate, coordinate]).default([0, 0, 0]),
    /** Turn about the parent's Z axis, in degrees. */
    rotation: z.number().min(-360).max(360).default(0),
    orientation: z.tuple([z.number(),z.number(),z.number()]).optional(),
  })
  .strict();

export const FirmwareSchema = z
  .object({
    repository: url,
    path: z.string().trim().max(200).default(""),
    /** The tag, branch or commit the build flashes. */
    ref: z.string().trim().min(1).max(100),
    /** The chip target, such as esp32s3. */
    target: z.string().trim().min(1).max(40),
  })
  .strict();

export const ITEM_KINDS = ["assembly", "printed", "fabricated", "cots", "pcb", "firmware"] as const;

const configurationName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const AssemblyReferenceSchema = z.object({
  projectId: z.uuid(),
  revision: z.int().positive().optional(),
  configuration: configurationName.optional(),
  parameters: z.record(configurationName, z.number()).optional(),
}).strict();
const configurationSchema = z.object({
  name: configurationName, rootId: z.uuid(),
  parameters: z.array(z.object({
    name: configurationName, min: z.number(), max: z.number(), defaultValue: z.number(),
    placements: z.array(z.object({
      parentId: z.uuid(), usageId: z.uuid(), axis: z.enum(["x","y","z"]),
      scale: z.number(), offset: z.number(),
    }).strict()).min(1),
  }).strict()).optional(),
}).strict();
export type AssemblyReference = z.infer<typeof AssemblyReferenceSchema>;

export const ItemSchema = z
  .object({
    id: z.uuid(),
    /** The part number. A change that breaks interchangeability needs a new one. */
    number: z.string().trim().min(1).max(60),
    revision: z.string().regex(/^[A-Z]{1,2}$/, "Use letters such as A or AB"),
    name: z.string().trim().min(1).max(150),
    kind: z.enum(ITEM_KINDS),
    manufacturer: z.string().trim().max(100).default(""),
    mpn: z.string().trim().max(100).default(""),
    source: url.default(""),
    estimatedUnitCost: z.number().nonnegative().optional(),
    unitCost: z.number().min(0).max(100000).default(0),
    /** How Workshop's inventory tells physical units apart. */
    trackBy: z.enum(["none", "mac", "serial"]).default("none"),
    opacity: z.number().min(0).max(1).optional(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    /** Solid geometry in the item's own coordinates. For COTS parts it is an
     * envelope, not the manufacturer's model. */
    geometry: AssemblyCadPlanSchema.optional(),
    mesh: z.object({path:ArtifactPathSchema, bounds:meshBounds}).optional(),
    files: z.array(assemblyFile).optional(),
    cotsEvidence: cotsEvidence.optional(),
    cotsEvidenceRef: cotsEvidenceRef.optional(),
    priceKnown: z.boolean().default(false),
    provenance: z.enum(["provisional","manufacturer","measured"]).default("provisional"),
    reference: AssemblyReferenceSchema.optional(),
    /** Pick this assembly when a user clicks one of its installed parts. */
    operations: z.array(OperationSchema).optional(),
    driveMotion: SavedDriveMotionSchema.optional(),
    selectAsUnit: z.boolean().optional(),
    firmware: FirmwareSchema.optional(),
    power: ItemPowerSchema.optional(),
    notes: z.string().max(2000).default(""),
    uses: z.array(UsageSchema).max(50).default([]),
  })
  .strict()
  .refine(item => !item.reference || (item.kind === "assembly" && !item.files?.length && !item.geometry && !item.mesh && !item.uses.length && !item.power && !item.unitCost && item.estimatedUnitCost === undefined), "Referenced assembly geometry, loads, cost and children belong to its source")
  .refine(item => !(item.cotsEvidence || item.cotsEvidenceRef) || (item.kind === "cots" && !(item.cotsEvidence && item.cotsEvidenceRef)), "COTS items own evidence or reference its owner")
  .refine((item) => item.kind === "assembly" || !item.uses.length, "Only an assembly contains other items")
  .refine((item) => (item.kind === "firmware") === Boolean(item.firmware), "Firmware items, and only they, name a repository and ref")
  .refine((item) => item.kind !== "firmware" || !item.geometry, "Firmware has no geometry");

export type Item = z.infer<typeof ItemSchema>;
export type Usage = z.infer<typeof UsageSchema>;

function assemblySchema(uniquePartNumbers: boolean) { return z
  .object({
    rootId: z.uuid().optional(),

    items: z.array(ItemSchema),
    configurations: z.array(configurationSchema).optional(),
    power: PowerSystemSchema.optional(),
  })
  .strict()
  .superRefine((assembly, ctx) => {
    validateAssemblyPower(assembly, ctx);
    const byId = new Map(assembly.items.map((item) => [item.id, item]));
    const configs = assembly.configurations ?? [];
    const fail = (message: string) => ctx.addIssue({code:"custom",message});
    if (new Set(configs.map(c=>c.name)).size !== configs.length) fail("Configuration names must be unique");
    for (const config of configs) {
      if (byId.get(config.rootId)?.kind !== "assembly") fail("Configuration root must be a saved assembly");
      const bindings = new Set<string>(), names = new Set<string>();
      for (const p of config.parameters ?? []) {
        if (names.has(p.name) || p.defaultValue < p.min || p.defaultValue > p.max) fail("Invalid configuration parameter definition");
        names.add(p.name);
        for (const binding of p.placements) {
          const key = [binding.parentId,binding.usageId,binding.axis].join("/");
          if (bindings.has(key) || !byId.get(binding.parentId)?.uses.some(u=>u.id===binding.usageId)) fail("Invalid or duplicate placement binding");
          if ([p.min,p.max].some(v=>Math.abs(binding.offset+binding.scale*v)>10000)) fail("Configured placement exceeds the coordinate range");
          bindings.add(key);
        }
      }
    }
    for (const owner of assembly.items) {
      if (owner.operations?.length) {
        if (owner.kind !== "assembly" || owner.reference) fail("Operations belong on the source assembly");
        if (new Set(owner.operations.map(op=>op.name)).size !== owner.operations.length) fail("Operation names must be unique within an assembly");
      }
      const spec = owner.driveMotion;
      if (!spec) continue;
      if (owner.reference || owner.kind !== "assembly") fail("Drive motion belongs on a source assembly");
      const reachable = new Set<string>();
      const usages = new Map<string, Item[]>();
      function collect(id: string) {
        const item = byId.get(id);
        if (!item || reachable.has(id)) return;
        reachable.add(id);
        for (const use of item.uses) {
          const target = byId.get(use.itemId);
          if (target) usages.set(use.id, [...(usages.get(use.id) ?? []), target]);
          collect(use.itemId);
        }
      }
      collect(owner.id);
      if (!spec.viewRootIds.includes(owner.id)) fail("Motion view roots must include the owning drive assembly");
      if (spec.viewRootIds.some(id => !reachable.has(id))) fail("Motion view root must belong to its source assembly");
      if (spec.z.translationUsageIds.some(id => usages.get(id)?.length !== 1)) fail("Motion translation needs a unique source usage");
      for (const r of spec.z.rotations) {
        const targets = usages.get(r.usageId);
        if (targets?.length !== 1 || targets[0].uses.length || !(targets[0].geometry || targets[0].mesh))
          fail("Motion rotation needs a unique saved leaf solid usage");
      }
    }
    if (byId.size !== assembly.items.length)
      ctx.addIssue({ code: "custom", message: "Item IDs must be unique" });
    const numbers = new Set(assembly.items.map((item) => item.number));
    if (uniquePartNumbers && numbers.size !== assembly.items.length)
      ctx.addIssue({ code: "custom", message: "Part numbers must be unique" });
    for (const item of assembly.items)
      for (const use of item.uses)
        if (!byId.has(use.itemId))
          ctx.addIssue({ code: "custom", message: `${item.number} uses a missing item` });
    if (assembly.rootId && byId.get(assembly.rootId)?.kind !== "assembly")
      ctx.addIssue({ code: "custom", message: "The top item must be an assembly" });
    // An item may appear in several places, but never inside itself.
    const state = new Map<string, "open" | "done">();
    const visit = (id: string): boolean => {
      if (state.get(id) === "done") return true;
      if (state.get(id) === "open") return false;
      state.set(id, "open");
      const ok = (byId.get(id)?.uses ?? []).every((use) => visit(use.itemId));
      state.set(id, "done");
      return ok;
    };
    if (!assembly.items.every((item) => visit(item.id)))
      ctx.addIssue({ code: "custom", message: "An assembly cannot contain itself" });
  });

}
export const AssemblySchema = assemblySchema(true);
// Built snapshots can contain different source projects with the same local part number.
export const BuildAssemblySchema = assemblySchema(false);
export type Assembly = z.infer<typeof AssemblySchema>;

export type BomRow = {
  item: Item;
  depth: number;
  /** Units per one top assembly. */
  quantity: number;
  refdes: string;
  path: string;
};

/** The indented BOM from the top assembly down, as PLM structure views show it. */
export function bomRows(assembly: Assembly): BomRow[] {
  const byId = new Map(assembly.items.map((item) => [item.id, item]));
  const root = assembly.rootId ? byId.get(assembly.rootId) : undefined;
  if (!root) return [];
  const rows: BomRow[] = [];
  const walk = (item: Item, depth: number, quantity: number, refdes: string, path: string) => {
    rows.push({ item, depth, quantity, refdes, path });
    for (const use of item.uses) {
      const child = byId.get(use.itemId);
      if (child) walk(child, depth + 1, quantity * use.quantity, use.refdes, `${path}/${use.id}`);
    }
  };
  walk(root, 0, 1, "", root.id);
  return rows;
}

/** Total quantity of each item for one top assembly. */
export function bomTotals(assembly: Assembly) {
  const totals = new Map<string, { item: Item; quantity: number }>();
  for (const row of bomRows(assembly).slice(1)) {
    const entry = totals.get(row.item.id) ?? { item: row.item, quantity: 0 };
    entry.quantity += row.quantity;
    totals.set(row.item.id, entry);
  }
  return { lines: [...totals.values()] };
}

/** Purchase price for one build. A quoted assembly covers its children. */
export function buildPrice(assembly: Assembly) {
  const byId = new Map(assembly.items.map(item => [item.id, item]));
  type Price = { knownSubtotal: number; estimatedSubtotal: number; unpricedUnits: number };
  const memo = new Map<string, Price>();
  function price(item: Item): Price {
    const cached = memo.get(item.id);
    if (cached) return cached;
    const total = { knownSubtotal: 0, estimatedSubtotal: 0, unpricedUnits: 0 };
    if (item.priceKnown) total.knownSubtotal = item.unitCost;
    else if (item.estimatedUnitCost !== undefined) total.estimatedSubtotal = item.estimatedUnitCost;
    else if (!item.uses.length) total.unpricedUnits = Number(item.kind !== "firmware");
    else for (const use of item.uses) {
      const child = price(byId.get(use.itemId)!);
      total.knownSubtotal += use.quantity * child.knownSubtotal;
      total.estimatedSubtotal += use.quantity * child.estimatedSubtotal;
      total.unpricedUnits += use.quantity * child.unpricedUnits;
    }
    memo.set(item.id, total);
    return total;
  }
  const root = assembly.rootId && byId.get(assembly.rootId);
  if (!root) return { knownSubtotal: 0, estimatedSubtotal: 0, unpricedUnits: 0 };
  const { knownSubtotal, estimatedSubtotal, unpricedUnits } = price(root);
  const cents = new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 2 });
  return { knownSubtotal: Number(cents.format(knownSubtotal)), estimatedSubtotal: Number(cents.format(estimatedSubtotal)), unpricedUnits };
}

export type Placement = {
  item: Item;
  path: string;
  /** World position of the item's origin, in mm. */
  position: [number, number, number];
  /** Total turn about Z, in degrees. */
  rotation: number;
  matrix?: number[];
  pickGroup?: { id: string; path: string };
};

/** Every solid in the top assembly, placed in world coordinates. */
export function placements(assembly: Assembly, options?: { maxVisits?: number; skipCoincidentCopies?: boolean; onVisit?: (item: Item, path: string, matrix: Matrix4, usage?: Usage) => void }): Placement[] {
  const byId = new Map(assembly.items.map((item) => [item.id, item]));
  const root = assembly.rootId ? byId.get(assembly.rootId) : undefined;
  if (!root) return [];
  const out: Placement[] = [];
  let remaining = options?.maxVisits ?? Infinity;
  const walk = (item: Item, matrix: Matrix4, path: string, pickGroup?: Placement["pickGroup"], usage?: Usage) => {
    remaining--;
    options?.onVisit?.(item,path,matrix,usage);
    const pos = new Vector3().setFromMatrixPosition(matrix);
    if (!pickGroup && item !== root && item.selectAsUnit && item.kind === "assembly") pickGroup = { id: item.id, path };
    if (item.geometry || item.mesh) out.push({item,path,pickGroup,position:pos.toArray() as [number,number,number],rotation:Math.round(new Euler().setFromRotationMatrix(matrix).z*180/Math.PI*1e9)/1e9,matrix:matrix.toArray()});
    for (const use of item.uses) {
      if (remaining <= 0) break;
      const child=byId.get(use.itemId);if(!child)continue;
      const angles=use.orientation ?? [0,0,use.rotation];
      const local=new Matrix4().compose(new Vector3(...use.position),new Quaternion().setFromEuler(new Euler(...angles.map(v=>v*Math.PI/180) as [number,number,number],"XYZ")),new Vector3(1,1,1));
      const copies = options?.skipCoincidentCopies ? 1 : use.quantity;
      for(let copy=0;copy<copies && remaining>0;copy++)walk(child,matrix.clone().multiply(local),`${path}/${use.id}#${copy}`,pickGroup,use);
    }
  };
  walk(root,new Matrix4(),root.id);
  return out;
}

/** The eight corners of an item's bounds, placed in world coordinates. */
export function worldCorners({ item, position, rotation, matrix }: Placement) {
  const b = item.mesh?.bounds ?? planBounds(item.geometry as CadPlan);
  const turn = (rotation * Math.PI) / 180;
  return [b.min[0], b.max[0]].flatMap((x) =>
    [b.min[1], b.max[1]].flatMap((y) =>
      [b.min[2], b.max[2]].map((z) => matrix ? new Vector3(x,y,z).applyMatrix4(new Matrix4().fromArray(matrix)).toArray() : [
        position[0] + x * Math.cos(turn) - y * Math.sin(turn),
        position[1] + x * Math.sin(turn) + y * Math.cos(turn),
        position[2] + z,
      ]),
    ),
  );
}

/** World bounds of the placed solids, for framing the view. */
export function assemblyBounds(list: Placement[]) {
  const corners = list.flatMap(worldCorners);
  if (!corners.length) return undefined;
  const axis = (i: number) => corners.map((corner) => corner[i]);
  return {
    min: [0, 1, 2].map((i) => Math.min(...axis(i))),
    max: [0, 1, 2].map((i) => Math.max(...axis(i))),
  };
}
