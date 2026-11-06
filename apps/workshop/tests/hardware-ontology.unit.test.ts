import assert from "node:assert/strict";
import test from "node:test";
import standardTypes from "@ai-outfitter/app-sdk/graph/standard-types.json";
import { hardwareOntology } from "../src/server/hardware-ontology";

test("Workshop's hardware types link only to standard Wiki types or its own", () => {
  const known = new Set([...standardTypes, ...hardwareOntology.types].map((type) => type.id));
  const name = (n: string) => hardwareOntology.types.find((type) => type.name === n);
  assert.deepEqual(hardwareOntology.types.map((type) => type.name).sort(), ["DesignArtifact", "TelemetryStream", "component_of", "design_of", "includes_component", "measures", "streams_from"]);
  for (const type of hardwareOntology.types) {
    const ends = (type.ontology as { endpoints?: { from: string[]; to: string[] } } | undefined)?.endpoints;
    for (const id of [...(ends?.from ?? []), ...(ends?.to ?? [])]) assert.ok(known.has(id), `${type.name} → ${id}`);
  }
  assert.deepEqual(name("DesignArtifact")?.properties.map((property) => property.name), ["format", "design_key", "url"]);
  assert.deepEqual(name("TelemetryStream")?.properties.map((property) => property.name), ["transport", "schema", "interval"]);
  const concept = hardwareOntology.nodes.find((node) => node.slug === "design-concept");
  assert.equal(JSON.parse(String(concept?.body)).artifactKind, "design concept");
  assert.ok(known.has(String(concept?.typeId)), "Design concept is a standard ArtifactDefinition");
});
