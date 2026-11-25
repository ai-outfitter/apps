import { bomTotals } from "./assembly";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { strToU8, zipSync } from "fflate";
import metadata from "../../app.json" with { type: "json" };
import { designKey, fitReady, type Project, pcbReady } from "./project";

const csv = (x: unknown) => {
  const s = String(x);
  return (
    '"' +
    (typeof x === "string" && /^[=+@\-\t\r]/.test(s) ? "'" : "") +
    s.replaceAll('"', '""') +
    '"'
  );
};
export function projectPackage(p: Project, bomAssembly = p.assembly, fitTrials: readonly unknown[] = []) {
  const parameters =
    p.params.design === "custom"
      ? {
          design: "custom",
          width: p.params.width,
          depth: p.params.depth,
          height: p.params.height,
        }
      : p.params;
  const root = bomAssembly.items.find(item => item.id === bomAssembly.rootId);
  const lines = root ? [{item: root, quantity: 1}, ...bomTotals(bomAssembly).lines] : [];
  const files: Record<string, string> = {
    "project.json": JSON.stringify(p, null, 2),
    "requirements.md": `# ${p.name}\n\n${p.brief}\n\n${p.requirements}\n`,
    "measurements.json": JSON.stringify(
      { units: "mm", parameters, provenance: p.measurementNotes },
      null,
      2,
    ),
    "bom.csv": [
      ["Part", "Quantity", "Unit cost USD", "Source", "Notes", "Estimated unit cost USD"],
      ...(bomAssembly.rootId
        ? lines.filter(({item}) => item.kind !== "assembly" || item.priceKnown || item.estimatedUnitCost !== undefined)
            .map(({item, quantity}) => [item.name, quantity, item.priceKnown ? item.unitCost : item.estimatedUnitCost === undefined ? "Unpriced" : "", item.source, item.notes, item.estimatedUnitCost ?? ""])
        : p.parts.map(part => [part.name, part.quantity, part.unitCost, part.source, part.notes, ""])),
    ]
      .map((r) => r.map(csv).join(","))
      .join("\n"),
    "research.json": JSON.stringify(p.research, null, 2),
    "electronics-baseline.md":
      p.circuitNotes || "No electrical baseline recorded.\n",
    "evidence.json": JSON.stringify(p.evidence, null, 2),
    "README.md": `# ${p.name} — draft package\n\nProject revision: ${p.revision}.\n${p.productRevision ? `Builds product revision: ${p.productRevision.title || p.productRevision.id}${p.productRevision.url ? ` (${p.productRevision.url})` : ""}.\n` : ""}Physical fit for these dimensions: ${fitReady(p) ? "recorded pass" : "not accepted"}.\nBreadboard: ${pcbReady(p) ? "recorded pass" : "not accepted / not applicable"}.\n\nThis archive records the project. Export matching STEP/STL files from the Design tab. It is not a manufacturing approval. Keep the template source revision with these files.\n`,
  };
  if (fitTrials.length) files["fit-trials.json"] = JSON.stringify(fitTrials, null, 2);
  if(p.workspace)files["workspace.json"]=JSON.stringify(p.workspace,null,2);
  if(p.assembly.rootId)files["assembly.json"]=JSON.stringify(p.assembly,null,2);
  if (p.cadPlan) files["cad-plan.json"] = JSON.stringify(p.cadPlan, null, 2);
  if (p.kind === "electronics")
    files["electronics/pcb-handoff.md"] =
      `# PCB handoff\n\n${pcbReady(p) ? "Breadboard pass recorded; design investigation may proceed." : "BLOCKED: record a passing breadboard test before PCB design."}\n\n1. Freeze the exact board, pin map, supply, connectors and parts.\n2. Compare perfboard, a COTS carrier and a custom PCB.\n3. Use the KiCad MCP example in this template to inspect a project.\n4. Review the schematic and run ERC.\n5. Review layout, run DRC, check the enclosure fit, and export fabrication files.\n6. Record independent review and physical bring-up.\n\nNo schematic or fabrication approval is included in this draft package.\n`;
  const manifest = {
    schemaVersion: p.schemaVersion,
    template: { name: metadata.id, version: metadata.version },
    designKey: designKey(p),
    parameters,
    projectId: p.id,
    revision: p.revision,
    productRevision: p.productRevision ?? null,
    generatedAt: new Date().toISOString(),
    status: "draft",
    files: Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        bytesToHex(sha256(strToU8(body))),
      ]),
    ),
  };
  files["manifest.json"] = JSON.stringify(manifest, null, 2);
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, body]) => [name, strToU8(body)]),
    ),
  );
}
