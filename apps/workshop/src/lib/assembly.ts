import { z } from "zod";
import { type CadPlan, CadPlanSchema, planBounds } from "../model/cad-plan";

// A product structure in the shape Windchill and Teamcenter use: items (part
// masters with one current revision) and usage lines from an assembly item to
// the items it contains. An assembly line can point at another assembly, which
// makes a sub-assembly. Firmware is an item too, so the BOM lists the software
// a build needs alongside its hardware.

const url = z
  .string()
  .max(2000)
  .refine((s) => !s || /^https?:\/\//i.test(s), "Use an http or https URL");
const coordinate = z.number().min(-500).max(500);

export const UsageSchema = z
  .object({
    id: z.uuid(),
    itemId: z.uuid(),
    quantity: z.number().int().min(1).max(1000),
    /** Reference designators or a find number, such as "U1" or "Find 3". */
    refdes: z.string().trim().max(60).default(""),
    /** Where the item's origin sits in the parent assembly, in mm. */
    position: z.tuple([coordinate, coordinate, coordinate]).default([0, 0, 0]),
    /** Turn about the parent's Z axis, in degrees. */
    rotation: z.number().min(-360).max(360).default(0),
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

export const ITEM_KINDS = ["assembly", "printed", "cots", "pcb", "firmware"] as const;

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
    unitCost: z.number().min(0).max(100000).default(0),
    /** How Workshop's inventory tells physical units apart. */
    trackBy: z.enum(["none", "mac", "serial"]).default("none"),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    /** Solid geometry in the item's own coordinates. For COTS parts it is an
     * envelope, not the manufacturer's model. */
    geometry: CadPlanSchema.optional(),
    firmware: FirmwareSchema.optional(),
    notes: z.string().max(2000).default(""),
    uses: z.array(UsageSchema).max(50).default([]),
  })
  .strict()
  .refine((item) => item.kind === "assembly" || !item.uses.length, "Only an assembly contains other items")
  .refine((item) => (item.kind === "firmware") === Boolean(item.firmware), "Firmware items, and only they, name a repository and ref")
  .refine((item) => item.kind !== "firmware" || !item.geometry, "Firmware has no geometry");

export type Item = z.infer<typeof ItemSchema>;
export type Usage = z.infer<typeof UsageSchema>;

export const AssemblySchema = z
  .object({
    rootId: z.uuid().optional(),
    items: z.array(ItemSchema).max(200),
  })
  .strict()
  .superRefine((assembly, ctx) => {
    const byId = new Map(assembly.items.map((item) => [item.id, item]));
    if (byId.size !== assembly.items.length)
      ctx.addIssue({ code: "custom", message: "Item IDs must be unique" });
    const numbers = new Set(assembly.items.map((item) => item.number));
    if (numbers.size !== assembly.items.length)
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

/** Total quantity of each item for one top assembly, with its cost. */
export function bomTotals(assembly: Assembly) {
  const totals = new Map<string, { item: Item; quantity: number }>();
  for (const row of bomRows(assembly).slice(1)) {
    const entry = totals.get(row.item.id) ?? { item: row.item, quantity: 0 };
    entry.quantity += row.quantity;
    totals.set(row.item.id, entry);
  }
  const lines = [...totals.values()];
  return {
    lines,
    cost: lines.reduce((sum, line) => sum + line.quantity * line.item.unitCost, 0),
  };
}

export type Placement = {
  item: Item;
  path: string;
  /** World position of the item's origin, in mm. */
  position: [number, number, number];
  /** Total turn about Z, in degrees. */
  rotation: number;
};

/** Every solid in the top assembly, placed in world coordinates. */
export function placements(assembly: Assembly): Placement[] {
  const byId = new Map(assembly.items.map((item) => [item.id, item]));
  const root = assembly.rootId ? byId.get(assembly.rootId) : undefined;
  if (!root) return [];
  const out: Placement[] = [];
  const walk = (item: Item, position: [number, number, number], rotation: number, path: string) => {
    if (item.geometry) out.push({ item, path, position, rotation });
    const turn = (rotation * Math.PI) / 180;
    for (const use of item.uses) {
      const child = byId.get(use.itemId);
      if (!child) continue;
      const [x, y, z] = use.position;
      const at: [number, number, number] = [
        position[0] + x * Math.cos(turn) - y * Math.sin(turn),
        position[1] + x * Math.sin(turn) + y * Math.cos(turn),
        position[2] + z,
      ];
      for (let copy = 0; copy < use.quantity; copy++)
        walk(child, at, rotation + use.rotation, `${path}/${use.id}#${copy}`);
    }
  };
  walk(root, [0, 0, 0], 0, root.id);
  return out;
}

/** The eight corners of an item's bounds, placed in world coordinates. */
function worldCorners({ item, position, rotation }: Placement) {
  const b = planBounds(item.geometry as CadPlan);
  const turn = (rotation * Math.PI) / 180;
  return [b.min[0], b.max[0]].flatMap((x) =>
    [b.min[1], b.max[1]].flatMap((y) =>
      [b.min[2], b.max[2]].map((z) => [
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
