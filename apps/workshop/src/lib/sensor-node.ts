import type { CadPlan } from "../model/cad-plan";
import { type Assembly, AssemblySchema, type Item } from "./assembly";

// The starter assembly: a solar soil, CO2 and light sensor in the shape of
// Sunny's SNY-1 research. COTS geometry is a dimensioned envelope for fit
// checks, not the manufacturer's model; check each against its drawing.

type Feature = CadPlan["features"][number];
const box = (origin: [number, number, number], size: [number, number, number], mode: "add" | "cut" = "add"): Feature => ({ kind: "box", mode, origin, size });
const cylinder = (base: [number, number, number], radius: number, height: number, axis: "x" | "y" | "z", mode: "add" | "cut" = "add"): Feature => ({ kind: "cylinder", mode, base, radius, height, axis });
const plan = (...features: Feature[]): CadPlan => ({ version: 1, units: "mm", features });

const W = 140, D = 95, H = 35, T = 2.5;
const corners = [[-63, -40.5], [63, -40.5], [-63, 40.5], [63, 40.5]] as const;

const enclosure = plan(
  box([-W / 2, -D / 2, 0], [W, D, H]),
  box([-W / 2 + T, -D / 2 + T, T], [W - 2 * T, D - 2 * T, H], "cut"),
  // Probe slot through the floor and an air vent beside the CO2 sensor.
  box([38, -1.5, -1], [24, 3, T + 2], "cut"),
  box([25, D / 2 - T - 1, 12], [20, T + 2, 10], "cut"),
  ...corners.flatMap(([x, y]) => [cylinder([x, y, T], 4, H - T, "z"), cylinder([x, y, T], 1.25, H, "z", "cut")]),
);

const lid = plan(
  box([-W / 2, -D / 2, 0], [W, D, T]),
  // Window over the lux sensor, beside the panel.
  cylinder([-55, 0, -1], 3, T + 2, "z", "cut"),
  ...corners.map(([x, y]) => cylinder([x, y, -1], 1.6, T + 2, "z", "cut")),
);

const devkit = plan(
  box([-34.5, -12.7, 0], [69, 25.4, 1.6]),
  // ESP32-S3-WROOM-1 module at the antenna end, USB at the other.
  box([16.5, -12.75, 1.6], [18, 25.5, 3.1]),
  box([-34.5, -4, 1.6], [6, 8, 3]),
  // Two 22-pin headers below the board.
  box([-27.5, -12.7, -8.5], [55, 2.5, 8.5]),
  box([-27.5, 10.2, -8.5], [55, 2.5, 8.5]),
);

const breakout = (sensor: [number, number, number]) =>
  plan(box([-12.7, -8.9, 0], [25.4, 17.8, 1.6]), box([-sensor[0] / 2, -sensor[1] / 2, 1.6], sensor));

export function sensorNodeAssembly(): Assembly {
  const id = () => crypto.randomUUID();
  const item = (fields: Partial<Item> & Pick<Item, "number" | "name" | "kind">): Item => ({
    id: id(),
    priceKnown: false,
    provenance: "provisional",
    revision: "A",
    manufacturer: "",
    mpn: "",
    source: "",
    unitCost: 0,
    trackBy: "none",
    notes: "",
    uses: [],
    ...fields,
  });
  const use = (child: Item, position: [number, number, number] = [0, 0, 0], quantity = 1, refdes = "", rotation = 0) => ({
    id: id(),
    itemId: child.id,
    quantity,
    refdes,
    position,
    rotation,
  });

  const esp = item({
    number: "SNY-C001", name: "ESP32-S3-DevKitC-1-N8R8", kind: "cots", manufacturer: "Espressif",
    mpn: "ESP32-S3-DevKitC-1-N8R8", unitCost: 15, trackBy: "mac", color: "#1f3a5f", geometry: devkit,
    source: "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html",
    notes: "Envelope: 69 × 25.4 mm board with the WROOM-1 module (18 × 25.5 × 3.1 mm). Check against Espressif's dimension drawing.",
  });
  const scd41 = item({
    number: "SNY-C002", name: "SCD41 CO2 sensor breakout", kind: "cots", manufacturer: "Sensirion",
    mpn: "SCD41-D-R2", unitCost: 20, color: "#2d6a4f", geometry: breakout([10.1, 10.1, 6.5]),
    notes: "Single-shot mode every 5 to 10 minutes keeps it within the solar budget.",
  });
  const veml = item({
    number: "SNY-C003", name: "VEML7700 lux sensor breakout", kind: "cots", manufacturer: "Vishay",
    mpn: "VEML7700-TT", unitCost: 1.41, color: "#2d6a4f", geometry: breakout([6.8, 2.35, 1]),
    notes: "LCSC lists VEML7700-TT as not recommended for new designs; check Vishay's successor.",
  });
  const charger = item({
    number: "SNY-C004", name: "CN3791 MPPT solar charger module", kind: "cots", manufacturer: "Consonance",
    mpn: "CN3791", unitCost: 5.99, color: "#264653",
    geometry: plan(box([-17.5, -11.5, 0], [35, 23, 1.6]), box([-4, -4, 1.6], [8, 8, 5])),
  });
  const cell = item({
    number: "SNY-C005", name: "IFR18650 LiFePO4 cell, 1500 mAh", kind: "cots", manufacturer: "Powersonic",
    mpn: "PSL-FP-IFR18650EC", unitCost: 3.5, color: "#6c757d",
    geometry: plan(cylinder([-32.5, 0, 0], 9, 65, "x")),
  });
  const panel = item({
    number: "SNY-C006", name: "6 V 1 W solar panel", kind: "cots", manufacturer: "Adafruit",
    mpn: "3809", unitCost: 19.95, color: "#14213d",
    geometry: plan(box([-56.5, -44.5, 0], [113, 89, 2.5])),
    notes: "Also the light-energy meter: short-circuit current through a shunt tracks irradiance.",
  });
  const probe = item({
    number: "SNY-C007", name: "Capacitive soil moisture probe v1.2", kind: "cots", unitCost: 1.3, color: "#9d0208",
    geometry: plan(box([-11.5, -0.6, -98], [23, 1.2, 108])),
  });
  const screws = item({ number: "SNY-C008", name: "M3 × 8 screw", kind: "cots", mpn: "ISO 7380 M3x8", unitCost: 0.1 });
  const firmware = item({
    number: "SNY-F001", name: "SNY-1 sensor firmware", kind: "firmware",
    firmware: { repository: "", path: "firmware/sny-1", ref: "v0.1.0", target: "esp32s3" },
    notes: "Built from the firmware repository; the repository is not chosen yet.",
  });
  const base = item({ number: "SNY-P001", name: "Enclosure base", kind: "printed", unitCost: 2.4, color: "#d8c3a5", geometry: enclosure, notes: "PETG or ASA for outdoor use." });
  const top = item({ number: "SNY-P002", name: "Enclosure lid", kind: "printed", unitCost: 0.9, color: "#d8c3a5", geometry: lid });
  const electronics = item({
    number: "SNY-A002", name: "Electronics sub-assembly", kind: "assembly",
    notes: "Wired on a perfboard for rev A; a PCB replaces it at rev B.",
  });
  electronics.uses = [
    use(esp, [-25, 20, 8.5], 1, "U1"),
    use(scd41, [35, 25, 0], 1, "U2"),
    use(charger, [35, -20, 0], 1, "U3"),
    use(cell, [-20, -25, 9], 1, "BT1"),
    use(firmware),
  ];
  const node = item({
    number: "SNY-A001", name: "SNY-1 soil sensor node", kind: "assembly",
    notes: "Solar soil-moisture, CO2 and light sensor. Rev A is a COTS prototype.",
  });
  node.uses = [
    use(base),
    use(top, [0, 0, H]),
    use(panel, [12.5, 0, H + T]),
    use(electronics, [0, 0, T]),
    use(veml, [-55, 0, H - 2.4], 1, "U4", 90),
    use(probe, [50, 0, T], 1, "J1"),
    use(screws, [0, 0, 0], 4),
  ];
  return AssemblySchema.parse({
    rootId: node.id,
    items: [node, electronics, base, top, esp, scd41, veml, charger, cell, panel, probe, screws, firmware],
  });
}
