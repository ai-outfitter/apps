import { makeProject, type Project, ProjectSchema } from "../lib/project";
import type { Unit } from "../server/units";

const date = "2026-10-02T15:00:00.000Z";

const sensor = makeProject("sensor");
Object.assign(sensor, {
  id: "00000000-0000-4000-8000-000000000101",
  revision: 2,
  createdAt: date,
  updatedAt: date,
  name: "Sensor mount study",
  phase: "validation",
  owner: "Mara Chen",
  brief: "Hold a small sensor at 30° on a desk to compare readings without repositioning it.",
  requirements: "Keep the angle repeatable, allow cable clearance, and verify fit against the actual sensor before release.",
  measurementNotes: "Sensor envelope: 40 × 24 mm. Mounting-hole spacing needs a bench measurement.",
  research: [{
    id: "00000000-0000-4000-8000-000000000102",
    name: "Adjustable camera mount",
    kind: "COTS",
    url: "",
    notes: "Check whether the joint holds 30° under cable load.",
    decision: "Investigate",
  }],
  parts: [{
    id: "00000000-0000-4000-8000-000000000103",
    name: "M3 mounting screws",
    quantity: 4,
    unitCost: 0.35,
    source: "",
    notes: "Confirm required length after measuring the bracket.",
  }],
  iterations: [{
    id: "00000000-0000-4000-8000-000000000104",
    prompt: "Create a sensor bracket with a 30° face.",
    rationale: "The bracket envelope leaves room to assess mounting and cable clearance.",
    dimensions: { width: 85, depth: 55, height: 30 },
    at: date,
    revision: 2,
  }],
});

const cable = makeProject("holder");
Object.assign(cable, {
  id: "00000000-0000-4000-8000-000000000105",
  revision: 1,
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-30T11:30:00.000Z",
  phase: "manufacturing",
  owner: "Design team",
});

const node = makeProject("node");
Object.assign(node, {
  id: "00000000-0000-4000-8000-000000000106",
  revision: 3,
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-03T08:00:00.000Z",
  phase: "prototyping",
  owner: "Sunny",
});

export const fixtureProjects: Project[] = [
  ProjectSchema.parse(node),
  ProjectSchema.parse(cable),
  ProjectSchema.parse(sensor),
];

export function fixtureRequest<T>(path: string, method: string): T {
  if (method !== "GET") throw new Error("This installation is read-only.");
  if (!path)
    return fixtureProjects.map(({ id, name, revision, updatedAt, phase }) => ({
      id,
      name,
      revision,
      updatedAt,
      phase,
    })) as T;
  const found = fixtureProjects.find((item) => item.id === path.slice(1));
  if (!found) throw new Error("Project not found");
  return structuredClone(found) as T;
}

/** Demo inventory: ESP32-S3 boards on the bench, told apart by MAC address. */
export function fixtureUnits(): Unit[] {
  const at = "2026-11-02T16:00:00.000Z";
  const unit = (n: number, mac: string, status: Unit["status"], location: string, firmware: string): Unit => ({
    id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`,
    partNumber: "SNY-C001",
    mpn: "ESP32-S3-DevKitC-1-N8R8",
    mac,
    serial: null,
    status,
    location,
    projectId: status === "in-stock" ? null : node.id,
    firmware,
    notes: "",
    revision: 1,
    createdBy: "demo",
    updatedBy: "demo",
    createdAt: at,
    updatedAt: at,
  });
  return [
    unit(1, "34:85:18:7A:10:01", "installed", "Bench prototype 1", "v0.1.0"),
    unit(2, "34:85:18:7A:10:02", "allocated", "Bench", ""),
    unit(3, "34:85:18:7A:10:03", "in-stock", "Bin A3", ""),
    unit(4, "34:85:18:7A:10:04", "in-stock", "Bin A3", ""),
  ];
}
