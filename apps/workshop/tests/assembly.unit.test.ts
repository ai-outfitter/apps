import assert from "node:assert/strict";
import test from "node:test";
import { AssemblySchema, bomRows, bomTotals, placements } from "../src/lib/assembly";
import { makeProject, ProjectSchema } from "../src/lib/project";
import { sensorNodeAssembly } from "../src/lib/sensor-node";

test("the SNY-1 node is an assembly with an electronics sub-assembly, an ESP32-S3 and firmware", () => {
  const assembly = sensorNodeAssembly();
  const rows = bomRows(assembly);
  const at = (number: string) => rows.find((row) => row.item.number === number);
  assert.equal(rows[0].item.name, "SNY-1 soil sensor node");
  assert.deepEqual([at("SNY-A002")?.depth, at("SNY-C001")?.depth, at("SNY-F001")?.depth], [1, 2, 2]);
  assert.equal(at("SNY-C001")?.item.trackBy, "mac");
  assert.equal(at("SNY-C001")?.refdes, "U1");
  assert.deepEqual(at("SNY-F001")?.item.firmware, { repository: "", path: "firmware/sny-1", ref: "v0.1.0", target: "esp32s3" });
  assert.equal(at("SNY-C008")?.quantity, 4);
  // Cost per top assembly counts every line once per use.
  const { lines, cost } = bomTotals(assembly);
  assert.equal(lines.length, 12);
  assert.equal(Math.round(cost * 100) / 100, 70.85);
});

test("placements put each solid in world coordinates through its sub-assembly", () => {
  const list = placements(sensorNodeAssembly());
  const named = (name: string) => list.find((p) => p.item.name.startsWith(name));
  // Base, lid, panel, lux sensor, probe, and the four electronics parts; screws and firmware have no geometry.
  assert.equal(list.length, 9);
  assert.deepEqual(named("ESP32-S3")?.position, [-25, 20, 11]);
  assert.deepEqual(named("Enclosure lid")?.position, [0, 0, 35]);
  assert.equal(named("VEML7700")?.rotation, 90);
});

test("the assembly refuses cycles, missing items, and firmware with geometry", () => {
  const assembly = sensorNodeAssembly();
  const top = assembly.items[0];
  const sub = assembly.items[1];
  const withCycle = structuredClone(assembly);
  withCycle.items[1].uses.push({ id: crypto.randomUUID(), itemId: top.id, quantity: 1, refdes: "", position: [0, 0, 0], rotation: 0 });
  assert.match(AssemblySchema.safeParse(withCycle).error?.message ?? "", /cannot contain itself/);
  const missing = structuredClone(assembly);
  missing.items = missing.items.filter((item) => item.id !== sub.id);
  assert.match(AssemblySchema.safeParse(missing).error?.message ?? "", /missing item/);
  const firmware = structuredClone(assembly);
  const fw = firmware.items.find((item) => item.kind === "firmware");
  if (fw) fw.geometry = assembly.items.find((item) => item.geometry)?.geometry;
  assert.match(AssemblySchema.safeParse(firmware).error?.message ?? "", /Firmware has no geometry/);
  const leaf = structuredClone(assembly);
  const esp = leaf.items.find((item) => item.number === "SNY-C001");
  esp?.uses.push({ id: crypto.randomUUID(), itemId: top.id, quantity: 1, refdes: "", position: [0, 0, 0], rotation: 0 });
  assert.match(AssemblySchema.safeParse(leaf).error?.message ?? "", /Only an assembly/);
});

test("older projects without an assembly still load", () => {
  const { assembly: _assembly, ...older } = makeProject("holder");
  assert.deepEqual(ProjectSchema.parse(older).assembly, { items: [] });
  assert.ok(makeProject("node").assembly.rootId);
});
