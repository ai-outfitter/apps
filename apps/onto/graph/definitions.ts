import type { GraphContribution } from "@ai-outfitter/app-sdk/graph-authoring";
import types from "../seeds/types-v1.json";
import entities from "../seeds/entities-v1.json";
import lenses from "../seeds/knowledge-graphs-v1.json";
import artifacts from "../seeds/artifacts-v1.json";
import releases from "../seeds/releases-v1.json";
import example from "../seeds/release-example-v1.json";

import competitors from "../fixtures/competitors.json";

import { demoExample } from "./demo-fixture";
import { explorationGraph } from "./exploration-fixture";
import { readerGraph } from "./reader-fixture";

export default [
  { name: "types-v1", scope: "standard", types },
  { name: "entities-v1", scope: "standard", ...entities },
  { name: "knowledge-graphs-v1", scope: "standard", ...lenses },
  { name: "artifacts-v1", scope: "standard", ...artifacts },
  { name: "releases-v1", scope: "standard", ...releases },
  { name: "release-example-v1", scope: "fixture", ...example },
  { name: "competitors", scope: "fixture", ...competitors },
  { name: "demo-fixture", scope: "fixture", ...demoExample },
  { name: "exploration-fixture", scope: "fixture", isolated: true, ...explorationGraph },
  { name: "reader-fixture", scope: "fixture", ...readerGraph },
] as GraphContribution[];
